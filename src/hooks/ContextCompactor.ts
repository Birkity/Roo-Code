/** Context compaction utilities to prevent context window degradation. */

import * as fs from "node:fs"
import * as path from "node:path"

/**
 * A single conversation turn (message) in the agent's history.
 */
export interface ConversationTurn {
	role: "user" | "assistant" | "system" | "tool_result"
	content: string
	timestamp?: string
	toolName?: string
}

export interface CompactionConfig {
	/** Maximum token budget for compacted context (approximate, char-based) */
	maxTokenBudget: number

	/** Maximum length for individual tool outputs (chars) */
	maxToolOutputLength: number

	/** Number of recent turns to preserve in full (not summarized) */
	preserveRecentTurns: number

	/** Maximum length for the compacted summary of older turns */
	maxSummaryLength: number

	/** Whether to export state to .orchestration/TASKS.md */
	exportStateToTaskFile: boolean
}

export interface CompactionResult {
	/** The compacted conversation turns */
	compactedTurns: ConversationTurn[]

	/** Summary of the compacted (removed) older turns */
	summary: string

	/** Approximate token count before compaction */
	tokensBefore: number

	/** Approximate token count after compaction */
	tokensAfter: number

	/** Reduction ratio (0-1) */
	reductionRatio: number

	/** Number of turns removed */
	turnsRemoved: number

	/** Whether state was exported to TASKS.md */
	stateExported: boolean
}

export interface SubAgentContext {
	/** The sub-task specification injected as system prompt */
	taskSpec: string

	/** Relevant file content (scope-restricted) */
	relevantFiles: Array<{ path: string; content: string }>

	/** Compacted parent conversation (for continuity) */
	parentSummary: string

	/** The active intent context (XML block) */
	intentContext: string | null

	/** Approximate total token budget consumed */
	estimatedTokens: number
}

const CHARS_PER_TOKEN = 4

const DEFAULT_CONFIG: CompactionConfig = {
	maxTokenBudget: 120_000,
	maxToolOutputLength: 3000,
	preserveRecentTurns: 6,
	maxSummaryLength: 2000,
	exportStateToTaskFile: true,
}

const TRUNCATION_MARKER = "\n... [truncated — full output available via re-read]"

export class ContextCompactor {
	/** Truncate a tool output, preserving head and tail with a truncation marker. */
	static truncateToolOutput(output: string, maxLength: number = DEFAULT_CONFIG.maxToolOutputLength): string {
		if (output.length <= maxLength) {
			return output
		}

		const headLength = Math.floor(maxLength * 0.6)
		const tailLength = Math.floor(maxLength * 0.2)
		const removed = output.length - headLength - tailLength

		const head = output.substring(0, headLength)
		const tail = output.substring(output.length - tailLength)

		return `${head}\n\n... [${removed} characters truncated] ...\n\n${tail}`
	}

	/** Truncate tool outputs in a conversation history (only "tool_result" turns). */
	static truncateToolOutputsInHistory(
		turns: ConversationTurn[],
		maxLength: number = DEFAULT_CONFIG.maxToolOutputLength,
	): ConversationTurn[] {
		return turns.map((turn) => {
			if (turn.role === "tool_result" && turn.content.length > maxLength) {
				return {
					...turn,
					content: ContextCompactor.truncateToolOutput(turn.content, maxLength),
				}
			}
			return turn
		})
	}

	/** Compact a conversation by summarizing older turns and preserving the most recent ones. */
	static compact(turns: ConversationTurn[], config: Partial<CompactionConfig> = {}, cwd?: string): CompactionResult {
		const cfg = { ...DEFAULT_CONFIG, ...config }

		const tokensBefore = ContextCompactor.estimateTokens(turns)

		if (tokensBefore <= cfg.maxTokenBudget) {
			const compacted = ContextCompactor.truncateToolOutputsInHistory(turns, cfg.maxToolOutputLength)
			const tokensAfter = ContextCompactor.estimateTokens(compacted)
			return {
				compactedTurns: compacted,
				summary: "",
				tokensBefore,
				tokensAfter,
				reductionRatio: tokensBefore > 0 ? 1 - tokensAfter / tokensBefore : 0,
				turnsRemoved: 0,
				stateExported: false,
			}
		}

		const splitIndex = Math.max(0, turns.length - cfg.preserveRecentTurns)
		const olderTurns = turns.slice(0, splitIndex)
		const recentTurns = turns.slice(splitIndex)

		const summary = ContextCompactor.summarizeTurns(olderTurns, cfg.maxSummaryLength)

		const summaryTurn: ConversationTurn = {
			role: "system",
			content: `<context_summary>\n${summary}\n</context_summary>`,
			timestamp: new Date().toISOString(),
		}

		const compactedRecent = ContextCompactor.truncateToolOutputsInHistory(recentTurns, cfg.maxToolOutputLength)
		const compactedTurns = [summaryTurn, ...compactedRecent]
		const tokensAfter = ContextCompactor.estimateTokens(compactedTurns)

		let stateExported = false
		if (cfg.exportStateToTaskFile && cwd) {
			stateExported = ContextCompactor.exportStateToTaskFile(olderTurns, cwd)
		}

		return {
			compactedTurns,
			summary,
			tokensBefore,
			tokensAfter,
			reductionRatio: tokensBefore > 0 ? 1 - tokensAfter / tokensBefore : 0,
			turnsRemoved: olderTurns.length,
			stateExported,
		}
	}

	/** Prepare a focused context for a sub-agent spawn. */
	static prepareSubAgentContext(
		taskSpec: string,
		filePaths: string[],
		parentTurns: ConversationTurn[],
		intentContext: string | null,
		cwd: string,
	): SubAgentContext {
		const relevantFiles: Array<{ path: string; content: string }> = []
		for (const fp of filePaths) {
			const absolutePath = path.isAbsolute(fp) ? fp : path.join(cwd, fp)
			try {
				if (fs.existsSync(absolutePath)) {
					let content = fs.readFileSync(absolutePath, "utf-8")
					if (content.length > DEFAULT_CONFIG.maxToolOutputLength * 2) {
						content = ContextCompactor.truncateToolOutput(content, DEFAULT_CONFIG.maxToolOutputLength * 2)
					}
					relevantFiles.push({ path: fp, content })
				}
			} catch {}
		}

		const parentSummary = ContextCompactor.summarizeTurns(parentTurns, DEFAULT_CONFIG.maxSummaryLength)

		const tokensTaskSpec = Math.ceil(taskSpec.length / CHARS_PER_TOKEN)
		const tokensFiles = relevantFiles.reduce((sum, f) => sum + Math.ceil(f.content.length / CHARS_PER_TOKEN), 0)
		const tokensSummary = Math.ceil(parentSummary.length / CHARS_PER_TOKEN)
		const tokensIntent = intentContext ? Math.ceil(intentContext.length / CHARS_PER_TOKEN) : 0

		return {
			taskSpec,
			relevantFiles,
			parentSummary,
			intentContext,
			estimatedTokens: tokensTaskSpec + tokensFiles + tokensSummary + tokensIntent,
		}
	}

	/** Estimate token count from conversation turns (4 chars ≈ 1 token). */
	static estimateTokens(turns: ConversationTurn[]): number {
		const totalChars = turns.reduce((sum, turn) => sum + turn.content.length, 0)
		return Math.ceil(totalChars / CHARS_PER_TOKEN)
	}

	static estimateStringTokens(text: string): number {
		return Math.ceil(text.length / CHARS_PER_TOKEN)
	}

	/** Summarize conversation turns into a compact bullet-point string. */
	static summarizeTurns(turns: ConversationTurn[], maxLength: number): string {
		if (turns.length === 0) {
			return "No prior context."
		}

		const summaryParts: string[] = [`Summary of ${turns.length} prior conversation turns:`]

		for (const turn of turns) {
			let line: string

			switch (turn.role) {
				case "user":
					line = `- [User] ${ContextCompactor.firstLine(turn.content, 120)}`
					break

				case "assistant":
					if (turn.content.includes("tool_use") || turn.content.includes("<tool_call>")) {
						line = `- [Agent] Tool call: ${ContextCompactor.extractToolName(turn.content)}`
					} else {
						line = `- [Agent] ${ContextCompactor.firstLine(turn.content, 120)}`
					}
					break

				case "tool_result":
					line = `- [Result] ${turn.toolName ?? "tool"}: ${ContextCompactor.firstLine(turn.content, 80)}`
					break

				case "system":
					line = `- [System] ${ContextCompactor.firstLine(turn.content, 80)}`
					break

				default:
					line = `- [${turn.role}] ${ContextCompactor.firstLine(turn.content, 80)}`
			}

			summaryParts.push(line)

			if (summaryParts.join("\n").length >= maxLength) {
				summaryParts.push(`... and ${turns.length - summaryParts.length + 1} more turns (compacted)`)
				break
			}
		}

		const summary = summaryParts.join("\n")
		return summary.length > maxLength ? summary.substring(0, maxLength) + TRUNCATION_MARKER : summary
	}

	/** Export critical state from conversation to .orchestration/TASKS.md. */
	private static exportStateToTaskFile(turns: ConversationTurn[], cwd: string): boolean {
		try {
			const todoPath = path.join(cwd, ".orchestration", "TASKS.md")
			const todoDir = path.dirname(todoPath)

			if (!fs.existsSync(todoDir)) {
				fs.mkdirSync(todoDir, { recursive: true })
			}

			const timestamp = new Date().toISOString()
			const stateBlock = [
				"",
				`## Context Compaction — ${timestamp}`,
				"",
				"State variables exported before compaction:",
				"",
			]

			for (const turn of turns) {
				if (turn.role === "assistant" && turn.content.includes("TODO")) {
					const todoLines = turn.content
						.split("\n")
						.filter((line) => line.includes("TODO") || line.includes("- ["))
					for (const line of todoLines.slice(0, 10)) {
						stateBlock.push(`- ${line.trim()}`)
					}
				}
			}

			stateBlock.push("")

			fs.appendFileSync(todoPath, stateBlock.join("\n"), "utf-8")
			return true
		} catch (error) {
			console.warn(`[ContextCompactor] Failed to export state to TASKS.md: ${error}`)
			return false
		}
	}

	private static firstLine(content: string, maxLen: number): string {
		const line = content.split("\n")[0]?.trim() ?? ""
		return line.length > maxLen ? line.substring(0, maxLen) + "..." : line
	}

	private static extractToolName(content: string): string {
		const match = /<tool_name>(\w+)<\/tool_name>/.exec(content) ?? /name["']?\s*:\s*["'](\w+)/.exec(content)
		return match?.[1] ?? "unknown_tool"
	}
}
