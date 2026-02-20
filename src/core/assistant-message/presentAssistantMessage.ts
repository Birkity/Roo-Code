import { serializeError } from "serialize-error"
import { Anthropic } from "@anthropic-ai/sdk"

import type { ToolName, ClineAsk, ToolProgressStatus } from "@roo-code/types"
import { ConsecutiveMistakeError, TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { customToolRegistry } from "@roo-code/core"

import { t } from "../../i18n"

import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import type { ToolParamName, ToolResponse, ToolUse, McpToolUse } from "../../shared/tools"

import { AskIgnoredError } from "../task/AskIgnoredError"
import { Task } from "../task/Task"

import { listFilesTool } from "../tools/ListFilesTool"
import { readFileTool } from "../tools/ReadFileTool"
import { readCommandOutputTool } from "../tools/ReadCommandOutputTool"
import { writeToFileTool } from "../tools/WriteToFileTool"
import { editTool } from "../tools/EditTool"
import { searchReplaceTool } from "../tools/SearchReplaceTool"
import { editFileTool } from "../tools/EditFileTool"
import { applyPatchTool } from "../tools/ApplyPatchTool"
import { searchFilesTool } from "../tools/SearchFilesTool"
import { executeCommandTool } from "../tools/ExecuteCommandTool"
import { useMcpToolTool } from "../tools/UseMcpToolTool"
import { accessMcpResourceTool } from "../tools/accessMcpResourceTool"
import { askFollowupQuestionTool } from "../tools/AskFollowupQuestionTool"
import { switchModeTool } from "../tools/SwitchModeTool"
import { attemptCompletionTool, AttemptCompletionCallbacks } from "../tools/AttemptCompletionTool"
import { newTaskTool } from "../tools/NewTaskTool"
import { updateTodoListTool } from "../tools/UpdateTodoListTool"
import { runSlashCommandTool } from "../tools/RunSlashCommandTool"
import { skillTool } from "../tools/SkillTool"
import { generateImageTool } from "../tools/GenerateImageTool"
import { applyDiffTool as applyDiffToolClass } from "../tools/ApplyDiffTool"
import { isValidToolName, validateToolUse } from "../tools/validateToolUse"
import { codebaseSearchTool } from "../tools/CodebaseSearchTool"

import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"

/**
 * Processes and presents assistant message content to the user interface.
 *
 * This function is the core message handling system that:
 * - Sequentially processes content blocks from the assistant's response.
 * - Displays text content to the user.
 * - Executes tool use requests with appropriate user approval.
 * - Manages the flow of conversation by determining when to proceed to the next content block.
 * - Coordinates file system checkpointing for modified files.
 * - Controls the conversation state to determine when to continue to the next request.
 *
 * The function uses a locking mechanism to prevent concurrent execution and handles
 * partial content blocks during streaming. It's designed to work with the streaming
 * API response pattern, where content arrives incrementally and needs to be processed
 * as it becomes available.
 */

export async function presentAssistantMessage(cline: Task) {
	if (cline.abort) {
		throw new Error(`[Task#presentAssistantMessage] task ${cline.taskId}.${cline.instanceId} aborted`)
	}

	if (cline.presentAssistantMessageLocked) {
		cline.presentAssistantMessageHasPendingUpdates = true
		return
	}

	cline.presentAssistantMessageLocked = true
	cline.presentAssistantMessageHasPendingUpdates = false

	if (cline.currentStreamingContentIndex >= cline.assistantMessageContent.length) {
		// This may happen if the last content block was completed before
		// streaming could finish. If streaming is finished, and we're out of
		// bounds then this means we already  presented/executed the last
		// content block and are ready to continue to next request.
		if (cline.didCompleteReadingStream) {
			cline.userMessageContentReady = true
		}

		cline.presentAssistantMessageLocked = false
		return
	}

	let block: any
	try {
		// Performance optimization: Use shallow copy instead of deep clone.
		// The block is used read-only throughout this function - we never mutate its properties.
		// We only need to protect against the reference changing during streaming, not nested mutations.
		// This provides 80-90% reduction in cloning overhead (5-100ms saved per block).
		block = { ...cline.assistantMessageContent[cline.currentStreamingContentIndex] }
	} catch (error) {
		console.error(`ERROR cloning block:`, error)
		console.error(
			`Block content:`,
			JSON.stringify(cline.assistantMessageContent[cline.currentStreamingContentIndex], null, 2),
		)
		cline.presentAssistantMessageLocked = false
		return
	}

	switch (block.type) {
		case "mcp_tool_use":
			await handleMcpToolUseBlock(cline, block as McpToolUse)
			break
		case "text":
			await handleTextBlock(cline, block)
			break
		case "tool_use":
			await handleToolUseBlock(cline, block)
			break
	}

	cline.presentAssistantMessageLocked = false
	advanceToNextBlock(cline, block)
}

/**
 * Resolve tool result content from a ToolResponse, merging in any approval feedback.
 */
function resolveToolResultContent(
	content: ToolResponse,
	approvalFeedback?: { text: string; images?: string[] },
): { resultContent: string; imageBlocks: Anthropic.ImageBlockParam[] } {
	let resultContent: string
	let imageBlocks: Anthropic.ImageBlockParam[] = []

	if (typeof content === "string") {
		resultContent = content || "(tool did not return anything)"
	} else {
		const textBlocks = content.filter((item) => item.type === "text")
		imageBlocks = content.filter((item): item is Anthropic.ImageBlockParam => item.type === "image")
		resultContent =
			textBlocks.map((item) => (item as Anthropic.TextBlockParam).text).join("\n") ||
			"(tool did not return anything)"
	}

	if (approvalFeedback) {
		const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
		resultContent = `${feedbackText}\n\n${resultContent}`
		if (approvalFeedback.images) {
			const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
			imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
		}
	}

	return { resultContent, imageBlocks }
}

/**
 * Handle MCP tool use blocks — resolve server name and dispatch to useMcpToolTool.
 */
async function handleMcpToolUseBlock(cline: Task, mcpBlock: McpToolUse): Promise<void> {
	if (cline.didRejectTool) {
		const toolCallId = mcpBlock.id
		const errorMessage = !mcpBlock.partial
			? `Skipping MCP tool ${mcpBlock.name} due to user rejecting a previous tool.`
			: `MCP tool ${mcpBlock.name} was interrupted and not executed due to user rejecting a previous tool.`

		if (toolCallId) {
			cline.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(toolCallId),
				content: errorMessage,
				is_error: true,
			})
		}
		return
	}

	let hasToolResult = false
	const toolCallId = mcpBlock.id
	let approvalFeedback: { text: string; images?: string[] } | undefined

	const pushToolResult = (content: ToolResponse) => {
		if (hasToolResult) {
			console.warn(`[presentAssistantMessage] Skipping duplicate tool_result for mcp_tool_use: ${toolCallId}`)
			return
		}
		const { resultContent, imageBlocks } = resolveToolResultContent(content, approvalFeedback)

		if (toolCallId) {
			cline.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(toolCallId),
				content: resultContent,
			})
			if (imageBlocks.length > 0) {
				cline.userMessageContent.push(...imageBlocks)
			}
		}
		hasToolResult = true
	}

	const askApproval = async (
		type: ClineAsk,
		partialMessage?: string,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	) => {
		const { response, text, images } = await cline.ask(
			type,
			partialMessage,
			false,
			progressStatus,
			isProtected || false,
		)
		const result = await processApprovalResponse(cline, response, text, images, pushToolResult)
		if (result.feedback) {
			approvalFeedback = result.feedback
		}
		return result.approved
	}

	const handleError = async (action: string, error: Error) =>
		processToolCallError(cline, action, error, pushToolResult)

	if (!mcpBlock.partial) {
		cline.recordToolUsage("use_mcp_tool")
		TelemetryService.instance.captureToolUsage(cline.taskId, "use_mcp_tool")
	}

	const mcpHub = cline.providerRef.deref()?.getMcpHub()
	let resolvedServerName = mcpBlock.serverName
	if (mcpHub) {
		const originalName = mcpHub.findServerNameBySanitizedName(mcpBlock.serverName)
		if (originalName) {
			resolvedServerName = originalName
		}
	}

	const syntheticToolUse: ToolUse<"use_mcp_tool"> = {
		type: "tool_use",
		id: mcpBlock.id,
		name: "use_mcp_tool",
		params: {
			server_name: resolvedServerName,
			tool_name: mcpBlock.toolName,
			arguments: JSON.stringify(mcpBlock.arguments),
		},
		partial: mcpBlock.partial,
		nativeArgs: {
			server_name: resolvedServerName,
			tool_name: mcpBlock.toolName,
			arguments: mcpBlock.arguments,
		},
	}

	await useMcpToolTool.handle(cline, syntheticToolUse, {
		askApproval,
		handleError,
		pushToolResult,
	})
}

/**
 * Build a tool description string for logging and error messages.
 */
function getToolDescription(block: any, customModes: any[] | undefined): string {
	switch (block.name) {
		case "execute_command":
			return `[${block.name} for '${block.params.command}']`
		case "read_file":
			if (block.nativeArgs) {
				return readFileTool.getReadFileToolDescription(block.name, block.nativeArgs)
			}
			return readFileTool.getReadFileToolDescription(block.name, block.params)
		case "write_to_file":
			return `[${block.name} for '${block.params.path}']`
		case "apply_diff":
			return block.params?.path ? `[${block.name} for '${block.params.path}']` : `[${block.name}]`
		case "search_files":
			return `[${block.name} for '${block.params.regex}'${
				block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
			}]`
		case "edit":
		case "search_and_replace":
			return `[${block.name} for '${block.params.file_path}']`
		case "search_replace":
			return `[${block.name} for '${block.params.file_path}']`
		case "edit_file":
			return `[${block.name} for '${block.params.file_path}']`
		case "apply_patch":
			return `[${block.name}]`
		case "list_files":
			return `[${block.name} for '${block.params.path}']`
		case "use_mcp_tool":
			return `[${block.name} for '${block.params.server_name}']`
		case "access_mcp_resource":
			return `[${block.name} for '${block.params.server_name}']`
		case "ask_followup_question":
			return `[${block.name} for '${block.params.question}']`
		case "attempt_completion":
			return `[${block.name}]`
		case "switch_mode":
			return `[${block.name} to '${block.params.mode_slug}'${block.params.reason ? ` because: ${block.params.reason}` : ""}]`
		case "codebase_search":
			return `[${block.name} for '${block.params.query}']`
		case "read_command_output":
			return `[${block.name} for '${block.params.artifact_id}']`
		case "update_todo_list":
			return `[${block.name}]`
		case "new_task": {
			const taskMode = block.params.mode ?? defaultModeSlug
			const message = block.params.message ?? "(no message)"
			const modeName = getModeBySlug(taskMode, customModes)?.name ?? taskMode
			return `[${block.name} in ${modeName} mode: '${message}']`
		}
		case "run_slash_command": {
			const argsInfo = block.params.args ? ` with args: ${block.params.args}` : ""
			return `[${block.name} for '${block.params.command}'${argsInfo}]`
		}
		case "skill": {
			const argsInfo = block.params.args ? ` with args: ${block.params.args}` : ""
			return `[${block.name} for '${block.params.skill}'${argsInfo}]`
		}
		case "generate_image":
			return `[${block.name} for '${block.params.path}']`
		default:
			return `[${block.name}]`
	}
}

/**
 * Process an approval response — handle denial with feedback or store approval feedback.
 */
async function processApprovalResponse(
	cline: Task,
	response: string,
	text: string | undefined,
	images: string[] | undefined,
	pushToolResult: (content: ToolResponse) => void,
): Promise<{ approved: boolean; feedback?: { text: string; images?: string[] } }> {
	if (response !== "yesButtonClicked") {
		if (text) {
			await cline.say("user_feedback", text, images)
			pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
		} else {
			pushToolResult(formatResponse.toolDenied())
		}
		cline.didRejectTool = true
		return { approved: false }
	}

	if (text) {
		await cline.say("user_feedback", text, images)
		return { approved: true, feedback: { text, images } }
	}
	return { approved: true }
}

/**
 * Process a tool call error — log and push error result.
 */
async function processToolCallError(
	cline: Task,
	action: string,
	error: Error,
	pushToolResult: (content: ToolResponse) => void,
): Promise<void> {
	if (error instanceof AskIgnoredError) {
		return
	}
	const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
	await cline.say("error", `Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`)
	pushToolResult(formatResponse.toolError(errorString))
}

/**
 * Handle a tool_use block with a missing tool call ID.
 */
async function handleMissingToolCallId(cline: Task, block: any): Promise<void> {
	const errorMessage =
		"Invalid tool call: missing tool_use.id. XML tool calls are no longer supported. Remove any XML tool markup (e.g. <read_file>...</read_file>) and use native tool calling instead."
	try {
		if (typeof cline.recordToolError === "function" && typeof block.name === "string") {
			cline.recordToolError(block.name as ToolName, errorMessage)
		}
	} catch {
		// Best-effort only
	}
	cline.consecutiveMistakeCount++
	await cline.say("error", errorMessage)
	cline.userMessageContent.push({ type: "text", text: errorMessage })
	cline.didAlreadyUseTool = true
}

/**
 * Handle a rejected tool — push rejection message as tool_result.
 */
function handleRejectedToolUse(cline: Task, block: any, toolCallId: string, toolDescription: () => string): void {
	const errorMessage = !block.partial
		? `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`
		: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`

	cline.pushToolResultToUserContent({
		type: "tool_result",
		tool_use_id: sanitizeToolUseId(toolCallId),
		content: errorMessage,
		is_error: true,
	})
}

/**
 * Prepare a complete (non-partial) tool block for execution.
 * Validates native args, records usage, validates permissions, checks repetition, runs pre-hooks.
 * Returns true if tool execution should be aborted.
 */
async function prepareCompleteBlock(
	cline: Task,
	block: any,
	state: { mode?: string; customModes?: any[]; stateExperiments?: any; disabledTools?: string[] },
	toolCallId: string,
	pushToolResult: (content: ToolResponse) => void,
): Promise<boolean> {
	if (await validateNativeArgs(cline, block, state.stateExperiments, toolCallId)) {
		return true
	}
	recordToolUsageInfo(cline, block, state.stateExperiments)
	if (await validateToolPermissions(cline, block, state, toolCallId)) {
		return true
	}
	if (await checkToolRepetition(cline, block, pushToolResult)) {
		return true
	}
	return await runPreToolHooks(cline, block, pushToolResult)
}

/**
 * Validate that native args are present for known tools.
 * Returns true if execution should be aborted.
 */
async function validateNativeArgs(
	cline: Task,
	block: any,
	stateExperiments: any,
	toolCallId: string,
): Promise<boolean> {
	const customTool = stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined
	const isKnownTool = isValidToolName(String(block.name), stateExperiments)
	if (!isKnownTool || block.nativeArgs || customTool) {
		return false
	}
	const errorMessage =
		`Invalid tool call for '${block.name}': missing nativeArgs. ` +
		`This usually means the model streamed invalid or incomplete arguments and the call could not be finalized.`
	cline.consecutiveMistakeCount++
	try {
		cline.recordToolError(block.name as ToolName, errorMessage)
	} catch {
		// Best-effort only
	}
	cline.pushToolResultToUserContent({
		type: "tool_result",
		tool_use_id: sanitizeToolUseId(toolCallId),
		content: formatResponse.toolError(errorMessage),
		is_error: true,
	})
	return true
}

/**
 * Record tool usage for analytics and telemetry.
 */
function recordToolUsageInfo(cline: Task, block: any, stateExperiments: any): void {
	const isCustomTool = stateExperiments?.customTools && customToolRegistry.has(block.name)
	const recordName = isCustomTool ? "custom_tool" : block.name
	cline.recordToolUsage(recordName)
	TelemetryService.instance.captureToolUsage(cline.taskId, recordName)

	if (block.name === "read_file" && block.usedLegacyFormat) {
		const modelInfo = cline.api.getModel()
		TelemetryService.instance.captureEvent(TelemetryEventName.READ_FILE_LEGACY_FORMAT_USED, {
			taskId: cline.taskId,
			model: modelInfo?.id,
		})
	}
}

/**
 * Validate tool permissions (mode, disabled tools, etc.).
 * Returns true if execution should be aborted.
 */
async function validateToolPermissions(
	cline: Task,
	block: any,
	state: { mode?: string; customModes?: any[]; stateExperiments?: any; disabledTools?: string[] },
	toolCallId: string,
): Promise<boolean> {
	const modelInfo = cline.api.getModel()
	const rawIncludedTools = modelInfo?.info?.includedTools
	const { resolveToolAlias } = await import("../prompts/tools/filter-tools-for-mode")
	const includedTools = rawIncludedTools?.map((tool) => resolveToolAlias(tool))

	try {
		const toolRequirements =
			state.disabledTools?.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					const resolvedToolName = resolveToolAlias(tool)
					acc[resolvedToolName] = false
					return acc
				},
				{} as Record<string, boolean>,
			) ?? {}

		validateToolUse(
			block.name as ToolName,
			state.mode ?? defaultModeSlug,
			state.customModes ?? [],
			toolRequirements,
			block.params,
			state.stateExperiments,
			includedTools,
		)
		return false
	} catch (error) {
		cline.consecutiveMistakeCount++
		const errorContent = formatResponse.toolError(error.message)
		cline.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: sanitizeToolUseId(toolCallId),
			content: typeof errorContent === "string" ? errorContent : "(validation error)",
			is_error: true,
		})
		return true
	}
}

/**
 * Check for repeated identical tool calls.
 * Returns true if execution should be aborted.
 */
async function checkToolRepetition(
	cline: Task,
	block: any,
	pushToolResult: (content: ToolResponse) => void,
): Promise<boolean> {
	const repetitionCheck = cline.toolRepetitionDetector.check(block)
	if (!repetitionCheck.allowExecution && repetitionCheck.askUser) {
		const { response, text, images } = await cline.ask(
			repetitionCheck.askUser.messageKey as ClineAsk,
			repetitionCheck.askUser.messageDetail.replace("{toolName}", block.name),
		)

		if (response === "messageResponse") {
			cline.userMessageContent.push(
				{ type: "text" as const, text: `Tool repetition limit reached. User feedback: ${text}` },
				...formatResponse.imageBlocks(images),
			)
			await cline.say("user_feedback", text, images)
		}

		TelemetryService.instance.captureConsecutiveMistakeError(cline.taskId)
		TelemetryService.instance.captureException(
			new ConsecutiveMistakeError(
				`Tool repetition limit reached for ${block.name}`,
				cline.taskId,
				cline.consecutiveMistakeCount,
				cline.consecutiveMistakeLimit,
				"tool_repetition",
				cline.apiConfiguration.apiProvider,
				cline.api.getModel().id,
			),
		)

		pushToolResult(
			formatResponse.toolError(
				`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
			),
		)
		return true
	}
	return false
}

/**
 * Run pre-tool hooks (Gatekeeper, IntentContextLoader).
 * Returns true if execution should be aborted.
 */
async function runPreToolHooks(
	cline: Task,
	block: any,
	pushToolResult: (content: ToolResponse) => void,
): Promise<boolean> {
	const hookResult = await cline.hookEngine.runPreHooks(
		block.name,
		(block.nativeArgs as Record<string, unknown>) ?? block.params ?? {},
	)
	if (hookResult.action === "block" || hookResult.action === "inject") {
		pushToolResult(
			hookResult.action === "block" ? formatResponse.toolError(hookResult.toolResult) : hookResult.toolResult,
		)
		if (hookResult.action === "block") {
			cline.consecutiveMistakeCount++
		} else {
			cline.consecutiveMistakeCount = 0
		}
		return true
	}
	return false
}

/**
 * Dispatch the tool by name — route to the appropriate tool handler.
 */
async function dispatchToolByName(
	cline: Task,
	block: any,
	callbacks: {
		askApproval: (
			type: ClineAsk,
			partialMessage?: string,
			progressStatus?: ToolProgressStatus,
			isProtected?: boolean,
		) => Promise<boolean>
		handleError: (action: string, error: Error) => Promise<void>
		pushToolResult: (content: ToolResponse) => void
		askFinishSubTaskApproval: () => Promise<boolean>
		toolDescription: () => string
	},
	state: { mode?: string; stateExperiments?: any; customModes?: any[] },
): Promise<void> {
	const { askApproval, handleError, pushToolResult, askFinishSubTaskApproval, toolDescription } = callbacks

	switch (block.name) {
		case "write_to_file":
			await checkpointSaveAndMark(cline)
			await writeToFileTool.handle(cline, block as ToolUse<"write_to_file">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "update_todo_list":
			await updateTodoListTool.handle(cline, block as ToolUse<"update_todo_list">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "apply_diff":
			await checkpointSaveAndMark(cline)
			await applyDiffToolClass.handle(cline, block as ToolUse<"apply_diff">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "edit":
		case "search_and_replace":
			await checkpointSaveAndMark(cline)
			await editTool.handle(cline, block as ToolUse<"edit">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "search_replace":
			await checkpointSaveAndMark(cline)
			await searchReplaceTool.handle(cline, block as ToolUse<"search_replace">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "edit_file":
			await checkpointSaveAndMark(cline)
			await editFileTool.handle(cline, block as ToolUse<"edit_file">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "apply_patch":
			await checkpointSaveAndMark(cline)
			await applyPatchTool.handle(cline, block as ToolUse<"apply_patch">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "read_file":
			await readFileTool.handle(cline, block as ToolUse<"read_file">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "list_files":
			await listFilesTool.handle(cline, block as ToolUse<"list_files">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "codebase_search":
			await codebaseSearchTool.handle(cline, block as ToolUse<"codebase_search">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "search_files":
			await searchFilesTool.handle(cline, block as ToolUse<"search_files">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "execute_command":
			await executeCommandTool.handle(cline, block as ToolUse<"execute_command">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "read_command_output":
			await readCommandOutputTool.handle(cline, block as ToolUse<"read_command_output">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "use_mcp_tool":
			await useMcpToolTool.handle(cline, block as ToolUse<"use_mcp_tool">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "access_mcp_resource":
			await accessMcpResourceTool.handle(cline, block as ToolUse<"access_mcp_resource">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "ask_followup_question":
			await askFollowupQuestionTool.handle(cline, block as ToolUse<"ask_followup_question">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "switch_mode":
			await switchModeTool.handle(cline, block as ToolUse<"switch_mode">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "new_task":
			await checkpointSaveAndMark(cline)
			await newTaskTool.handle(cline, block as ToolUse<"new_task">, {
				askApproval,
				handleError,
				pushToolResult,
				toolCallId: block.id,
			})
			break
		case "attempt_completion": {
			const completionCallbacks: AttemptCompletionCallbacks = {
				askApproval,
				handleError,
				pushToolResult,
				askFinishSubTaskApproval,
				toolDescription,
			}
			await attemptCompletionTool.handle(cline, block as ToolUse<"attempt_completion">, completionCallbacks)
			break
		}
		case "run_slash_command":
			await runSlashCommandTool.handle(cline, block as ToolUse<"run_slash_command">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "skill":
			await skillTool.handle(cline, block as ToolUse<"skill">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "generate_image":
			await checkpointSaveAndMark(cline)
			await generateImageTool.handle(cline, block as ToolUse<"generate_image">, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		case "select_active_intent":
			// Handled by HookEngine pre-hook (IntentContextLoader).
			break
		default:
			await handleDefaultToolCase(cline, block, { askApproval, handleError, pushToolResult }, state)
			break
	}
}

/**
 * Handle the default (unknown/custom) tool case in the dispatch switch.
 */
async function handleDefaultToolCase(
	cline: Task,
	block: any,
	callbacks: {
		askApproval: (
			type: ClineAsk,
			partialMessage?: string,
			progressStatus?: ToolProgressStatus,
			isProtected?: boolean,
		) => Promise<boolean>
		handleError: (action: string, error: Error) => Promise<void>
		pushToolResult: (content: ToolResponse) => void
	},
	state: { mode?: string; stateExperiments?: any },
): Promise<void> {
	// Don't process partial blocks for unknown tools
	if (block.partial) {
		return
	}

	const customTool = state.stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined

	if (customTool) {
		try {
			let customToolArgs

			if (customTool.parameters) {
				try {
					customToolArgs = customTool.parameters.parse(block.nativeArgs || block.params || {})
				} catch (parseParamsError: any) {
					const message = `Custom tool "${block.name}" argument validation failed: ${parseParamsError.message}`
					console.error(message)
					cline.consecutiveMistakeCount++
					await cline.say("error", message)
					callbacks.pushToolResult(formatResponse.toolError(message))
					return
				}
			}

			const result = await customTool.execute(customToolArgs, {
				mode: state.mode ?? defaultModeSlug,
				task: cline,
			})

			console.log(`${customTool.name}.execute(): ${JSON.stringify(customToolArgs)} -> ${JSON.stringify(result)}`)

			callbacks.pushToolResult(result)
			cline.consecutiveMistakeCount = 0
		} catch (executionError: any) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("custom_tool", executionError.message)
			await callbacks.handleError(`executing custom tool "${block.name}"`, executionError)
		}
		return
	}

	// Not a custom tool - handle as unknown tool error
	const toolCallId = block.id as string
	const errorMessage = `Unknown tool "${block.name}". This tool does not exist. Please use one of the available tools.`
	cline.consecutiveMistakeCount++
	cline.recordToolError(block.name as ToolName, errorMessage)
	await cline.say("error", t("tools:unknownToolError", { toolName: block.name }))
	cline.pushToolResultToUserContent({
		type: "tool_result",
		tool_use_id: sanitizeToolUseId(toolCallId),
		content: formatResponse.toolError(errorMessage),
		is_error: true,
	})
}

/**
 * Run post-tool hooks after tool execution completes.
 */
async function runPostToolHooks(cline: Task, block: any): Promise<void> {
	const postFeedback = await cline.hookEngine.runPostHooks(
		block.name,
		(block.nativeArgs as Record<string, unknown>) ?? block.params ?? {},
	)

	if (postFeedback) {
		await cline.say("tool", postFeedback)
	}
}

/**
 * Handle a tool_use content block — validate, approve, and dispatch the tool.
 */
async function handleToolUseBlock(cline: Task, block: any): Promise<void> {
	// Native tool calling is the only supported tool calling mechanism.
	// A tool_use block without an id is invalid and cannot be executed.
	const toolCallId = block.id as string | undefined
	if (!toolCallId) {
		await handleMissingToolCallId(cline, block)
		return
	}

	// Fetch state early so it's available for toolDescription and validation
	const state = await cline.providerRef.deref()?.getState()
	const { mode, customModes, experiments: stateExperiments, disabledTools } = state ?? {}
	const toolDescription = (): string => getToolDescription(block, customModes)

	if (cline.didRejectTool) {
		handleRejectedToolUse(cline, block, toolCallId, toolDescription)
		return
	}

	// Track if we've already pushed a tool result for this tool call (native tool calling only)
	let hasToolResult = false

	// Store approval feedback to merge into tool result (GitHub #10465)
	let approvalFeedback: { text: string; images?: string[] } | undefined

	const pushToolResult = (content: ToolResponse) => {
		if (hasToolResult) {
			console.warn(`[presentAssistantMessage] Skipping duplicate tool_result for tool_use_id: ${toolCallId}`)
			return
		}
		const { resultContent, imageBlocks } = resolveToolResultContent(content, approvalFeedback)
		cline.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: sanitizeToolUseId(toolCallId),
			content: resultContent,
		})
		if (imageBlocks.length > 0) {
			cline.userMessageContent.push(...imageBlocks)
		}
		hasToolResult = true
	}

	const askApproval = async (
		type: ClineAsk,
		partialMessage?: string,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	) => {
		const { response, text, images } = await cline.ask(
			type,
			partialMessage,
			false,
			progressStatus,
			isProtected || false,
		)
		const result = await processApprovalResponse(cline, response, text, images, pushToolResult)
		if (result.feedback) {
			approvalFeedback = result.feedback
		}
		return result.approved
	}

	const askFinishSubTaskApproval = async () => {
		const toolMessage = JSON.stringify({ tool: "finishTask" })
		return await askApproval("tool", toolMessage)
	}

	const handleError = async (action: string, error: Error) =>
		processToolCallError(cline, action, error, pushToolResult)

	// Validate, record, and run pre-hooks for complete (non-partial) blocks
	if (!block.partial) {
		const shouldAbort = await prepareCompleteBlock(
			cline,
			block,
			{ mode, customModes, stateExperiments, disabledTools },
			toolCallId,
			pushToolResult,
		)
		if (shouldAbort) {
			return
		}
	}

	const callbacks = { askApproval, handleError, pushToolResult, askFinishSubTaskApproval, toolDescription }
	await dispatchToolByName(cline, block, callbacks, { mode, stateExperiments, customModes })

	// Run post-hooks for complete blocks
	if (!block.partial) {
		await runPostToolHooks(cline, block)
	}
}

/**
 * Handle a text content block — strip thinking tags and display to user.
 */
async function handleTextBlock(cline: Task, block: any): Promise<void> {
	if (cline.didRejectTool || cline.didAlreadyUseTool) {
		return
	}

	let content = block.content

	if (content) {
		content = content.replace(/<thinking>\s?/g, "")
		content = content.replace(/\s?<\/thinking>/g, "")
	}

	await cline.say("text", content, undefined, block.partial)
}

/**
 * Advance the streaming content index and recursively process the next block if available.
 */
function advanceToNextBlock(cline: Task, block: any): void {
	if (!block.partial || cline.didRejectTool || cline.didAlreadyUseTool) {
		if (cline.currentStreamingContentIndex === cline.assistantMessageContent.length - 1) {
			cline.userMessageContentReady = true
		}

		cline.currentStreamingContentIndex++

		if (cline.currentStreamingContentIndex < cline.assistantMessageContent.length) {
			presentAssistantMessage(cline)
			return
		}

		if (cline.didCompleteReadingStream) {
			cline.userMessageContentReady = true
		}
	}

	if (cline.presentAssistantMessageHasPendingUpdates) {
		presentAssistantMessage(cline)
	}
}

/**
 * save checkpoint and mark done in the current streaming task.
 * @param task The Task instance to checkpoint save and mark.
 * @returns
 */
async function checkpointSaveAndMark(task: Task) {
	if (task.currentStreamingDidCheckpoint) {
		return
	}
	try {
		await task.checkpointSave(true)
		task.currentStreamingDidCheckpoint = true
	} catch (error) {
		console.error(`[Task#presentAssistantMessage] Error saving checkpoint: ${error.message}`, error)
	}
}
