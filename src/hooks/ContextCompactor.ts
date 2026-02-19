/**
 * ContextCompactor.ts — Phase 4: Context Compaction for Multi-Agent Orchestration
 *
 * Implements a PreCompact hook that truncates raw tool outputs and summarizes
 * conversation history before passing context to a sub-agent. This prevents
 * "Context Rot" — the degradation of LLM reasoning when the context window
 * fills with redundant, verbose, or outdated information.
 *
 * Strategies implemented:
 *   1. Tool Output Truncation — Cap verbose tool outputs (file reads, search results)
 *   2. Conversation Summarization — Compress older turns into summaries
 *   3. Context Budget Tracking — Monitor token consumption against limits
 *   4. State Export — Extract critical variables to TASKS.md before compaction
 *
 * @see HookEngine.ts — orchestrates compaction as a pre-spawn hook
 * @see Research Paper: "Combating Context Rot and Infinite Loops"
 * @see TRP1 Challenge Week 1, Phase 4: Context Compaction
 */

import * as fs from "node:fs"
import * as path from "node:path"

// ── Types ────────────────────────────────────────────────────────────────

/**
 * A single conversation turn (message) in the agent's history.
 */
export interface ConversationTurn {
	role: "user" | "assistant" | "system" | "tool_result"
	content: string
	timestamp?: string
	toolName?: string
}

/**
 * Configuration for context compaction behavior.
 */
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

/**
 * Result of a context compaction operation.
 */
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

/**
 * Context prepared for a sub-agent spawn by the Supervisor.
 */
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

// ── Constants ────────────────────────────────────────────────────────────

/** Approximate character-to-token ratio (conservative for English text) */
const CHARS_PER_TOKEN = 4

/** Default compaction config */
const DEFAULT_CONFIG: CompactionConfig = {
	maxTokenBudget: 120_000, // ~120K tokens
	maxToolOutputLength: 3000, // 3K chars per tool output
	preserveRecentTurns: 6, // keep last 6 turns verbatim
	maxSummaryLength: 2000, // 2K chars for summary
	exportStateToTaskFile: true,
}

/** Truncation marker appended when content is cut */
const TRUNCATION_MARKER = "\n... [truncated — full output available via re-read]"

// ── ContextCompactor ──────────────────────────────────────────────────────

/**
 * Compacts conversation context to fight Context Rot.
 *
 * All methods are static — this is a pure utility class.
 */
export class ContextCompactor {
	// ── Tool Output Truncation ───────────────────────────────────────

	/**
	 * Truncate a single tool output to fit within the configured limit.
	 *
	 * Preserves the first and last portions of the output, with a
	 * truncation marker in the middle showing how much was removed.
	 *
	 * @param output - Raw tool output string
	 * @param maxLength - Maximum allowed length (default: config value)
	 * @returns Truncated output string
	 */
	static truncateToolOutput(output: string, maxLength: number = DEFAULT_CONFIG.maxToolOutputLength): string {
		if (output.length <= maxLength) {
			return output
		}

		// Keep first 60% and last 20%, add truncation marker in between
		const headLength = Math.floor(maxLength * 0.6)
		const tailLength = Math.floor(maxLength * 0.2)
		const removed = output.length - headLength - tailLength

		const head = output.substring(0, headLength)
		const tail = output.substring(output.length - tailLength)

		return `${head}\n\n... [${removed} characters truncated] ...\n\n${tail}`
	}

	/**
	 * Truncate tool outputs in a conversation history.
	 * Only modifies turns with role "tool_result".
	 */
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

	// ── Conversation Summarization ───────────────────────────────────

	/**
	 * Compact a conversation by summarizing older turns.
	 *
	 * Preserves the most recent N turns verbatim (these are the most
	 * contextually relevant). Older turns are summarized into a compact
	 * digest.
	 *
	 * @param turns  - Full conversation history
	 * @param config - Compaction configuration
	 * @param cwd    - Workspace root (for state export)
	 * @returns CompactionResult with compacted turns and metadata
	 */
	static compact(turns: ConversationTurn[], config: Partial<CompactionConfig> = {}, cwd?: string): CompactionResult {
		const cfg = { ...DEFAULT_CONFIG, ...config }

		const tokensBefore = ContextCompactor.estimateTokens(turns)

		// If already within budget, just truncate tool outputs
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

		// Split into old (to summarize) and recent (to preserve)
		const splitIndex = Math.max(0, turns.length - cfg.preserveRecentTurns)
		const olderTurns = turns.slice(0, splitIndex)
		const recentTurns = turns.slice(splitIndex)

		// Generate summary of older turns
		const summary = ContextCompactor.summarizeTurns(olderTurns, cfg.maxSummaryLength)

		// Build compacted context: summary turn + recent turns
		const summaryTurn: ConversationTurn = {
			role: "system",
			content: `<context_summary>\n${summary}\n</context_summary>`,
			timestamp: new Date().toISOString(),
		}

		const compactedRecent = ContextCompactor.truncateToolOutputsInHistory(recentTurns, cfg.maxToolOutputLength)
		const compactedTurns = [summaryTurn, ...compactedRecent]
		const tokensAfter = ContextCompactor.estimateTokens(compactedTurns)

		// Export state to TASKS.md if configured
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

	// ── Sub-Agent Context Preparation ────────────────────────────────

	/**
	 * Prepare a focused context for a sub-agent spawn.
	 *
	 * The Supervisor builds a narrow context window containing only:
	 *   1. The sub-task specification
	 *   2. Relevant file contents (within scope)
	 *   3. A compacted summary of the parent conversation
	 *   4. The active intent (if applicable)
	 *
	 * @param taskSpec       - The specific sub-task for the child agent
	 * @param filePaths      - Files to include in the context
	 * @param parentTurns    - The supervisor's full conversation (will be summarized)
	 * @param intentContext  - Active intent XML block
	 * @param cwd            - Workspace root
	 * @returns SubAgentContext ready for injection
	 */
	static prepareSubAgentContext(
		taskSpec: string,
		filePaths: string[],
		parentTurns: ConversationTurn[],
		intentContext: string | null,
		cwd: string,
	): SubAgentContext {
		// 1. Read relevant files (truncate if too large)
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
			} catch {
				// Skip unreadable files
			}
		}

		// 2. Summarize parent conversation
		const parentSummary = ContextCompactor.summarizeTurns(parentTurns, DEFAULT_CONFIG.maxSummaryLength)

		// 3. Estimate total tokens
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

	// ── Token Estimation ─────────────────────────────────────────────

	/**
	 * Estimate token count from conversation turns.
	 * Uses a conservative character-based heuristic (4 chars ≈ 1 token).
	 */
	static estimateTokens(turns: ConversationTurn[]): number {
		const totalChars = turns.reduce((sum, turn) => sum + turn.content.length, 0)
		return Math.ceil(totalChars / CHARS_PER_TOKEN)
	}

	/**
	 * Estimate token count from a single string.
	 */
	static estimateStringTokens(text: string): number {
		return Math.ceil(text.length / CHARS_PER_TOKEN)
	}

	// ── Private Helpers ──────────────────────────────────────────────

	/**
	 * Summarize a list of conversation turns into a compact string.
	 *
	 * This produces a structured bullet-point summary of key actions,
	 * decisions, and outputs from the conversation.
	 */
	static summarizeTurns(turns: ConversationTurn[], maxLength: number): string {
		if (turns.length === 0) {
			return "No prior context."
		}

		const summaryParts: string[] = [`Summary of ${turns.length} prior conversation turns:`]

		for (const turn of turns) {
			let line: string

			switch (turn.role) {
				case "user":
					// Extract first line as user intent
					line = `- [User] ${ContextCompactor.firstLine(turn.content, 120)}`
					break

				case "assistant":
					// Summarize assistant actions
					if (turn.content.includes("tool_use") || turn.content.includes("<tool_call>")) {
						line = `- [Agent] Tool call: ${ContextCompactor.extractToolName(turn.content)}`
					} else {
						line = `- [Agent] ${ContextCompactor.firstLine(turn.content, 120)}`
					}
					break

				case "tool_result":
					// Compact tool results to a single line
					line = `- [Result] ${turn.toolName ?? "tool"}: ${ContextCompactor.firstLine(turn.content, 80)}`
					break

				case "system":
					line = `- [System] ${ContextCompactor.firstLine(turn.content, 80)}`
					break

				default:
					line = `- [${turn.role}] ${ContextCompactor.firstLine(turn.content, 80)}`
			}

			summaryParts.push(line)

			// Stop adding if we've exceeded the budget
			if (summaryParts.join("\n").length >= maxLength) {
				summaryParts.push(`... and ${turns.length - summaryParts.length + 1} more turns (compacted)`)
				break
			}
		}

		const summary = summaryParts.join("\n")
		return summary.length > maxLength ? summary.substring(0, maxLength) + TRUNCATION_MARKER : summary
	}

	/**
	 * Export critical state from conversation to .orchestration/TASKS.md.
	 * This persists context variables before compaction destroys them.
	 */
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

			// Extract pending task items, decisions, or state from conversation
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

	/**
	 * Extract the first line of text, truncated to maxLen chars.
	 */
	private static firstLine(content: string, maxLen: number): string {
		const line = content.split("\n")[0]?.trim() ?? ""
		return line.length > maxLen ? line.substring(0, maxLen) + "..." : line
	}

	/**
	 * Extract tool name from an assistant message containing a tool call.
	 */
	private static extractToolName(content: string): string {
		// Try to extract from XML-style tool calls
		const match = /<tool_name>(\w+)<\/tool_name>/.exec(content) ?? /name["']?\s*:\s*["'](\w+)/.exec(content)
		return match?.[1] ?? "unknown_tool"
	}
}
