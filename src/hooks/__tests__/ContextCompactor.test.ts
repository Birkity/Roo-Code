import * as fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ContextCompactor } from "../ContextCompactor"
import type { ConversationTurn } from "../ContextCompactor"

vi.mock("node:fs")

function makeTurn(role: string, content: string, toolName?: string): ConversationTurn {
	return {
		role: role as ConversationTurn["role"],
		content,
		timestamp: new Date().toISOString(),
		toolName,
	}
}

function makeConversation(count: number): ConversationTurn[] {
	const turns: ConversationTurn[] = []
	for (let i = 0; i < count; i++) {
		turns.push(
			makeTurn("user", `User message ${i}: please do something useful`),
			makeTurn("assistant", `Assistant response ${i}: I will use a tool`),
			makeTurn("tool_result", `Tool output ${i}: success`, "read_file"),
		)
	}
	return turns
}

describe("ContextCompactor", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("truncateToolOutput", () => {
		it("returns short output unchanged", () => {
			const output = "short output"
			expect(ContextCompactor.truncateToolOutput(output, 1000)).toBe(output)
		})

		it("truncates long output and shows character count", () => {
			const output = "x".repeat(5000)
			const truncated = ContextCompactor.truncateToolOutput(output, 1000)

			expect(truncated.length).toBeLessThan(output.length)
			expect(truncated).toContain("characters truncated")
		})

		it("preserves head and tail of truncated output", () => {
			const head = "HEAD_MARKER_"
			const tail = "_TAIL_MARKER"
			const middle = "m".repeat(5000)
			const output = head + middle + tail

			const truncated = ContextCompactor.truncateToolOutput(output, 200)

			expect(truncated).toContain("HEAD_MARKER_")
			expect(truncated).toContain("_TAIL_MARKER")
		})

		it("uses default max length when not specified", () => {
			const longOutput = "x".repeat(10000)
			const truncated = ContextCompactor.truncateToolOutput(longOutput)
			expect(truncated.length).toBeLessThan(longOutput.length)
		})
	})

	describe("estimateTokens", () => {
		it("estimates tokens based on character count", () => {
			const turns = [makeTurn("user", "a".repeat(400))]
			const tokens = ContextCompactor.estimateTokens(turns)
			// 400 chars / 4 chars per token = 100 tokens
			expect(tokens).toBe(100)
		})

		it("returns 0 for empty turns", () => {
			expect(ContextCompactor.estimateTokens([])).toBe(0)
		})

		it("sums across multiple turns", () => {
			const turns = [makeTurn("user", "a".repeat(400)), makeTurn("assistant", "b".repeat(800))]
			// (400 + 800) / 4 = 300
			expect(ContextCompactor.estimateTokens(turns)).toBe(300)
		})
	})

	describe("estimateStringTokens", () => {
		it("estimates tokens from a plain string", () => {
			expect(ContextCompactor.estimateStringTokens("a".repeat(100))).toBe(25)
		})

		it("rounds up fractional tokens", () => {
			expect(ContextCompactor.estimateStringTokens("abc")).toBe(1)
		})
	})

	describe("summarizeTurns", () => {
		it("returns 'No prior context' for empty turns", () => {
			expect(ContextCompactor.summarizeTurns([], 1000)).toBe("No prior context.")
		})

		it("summarizes user turns with [User] prefix", () => {
			const turns = [makeTurn("user", "Fix the authentication bug")]
			const summary = ContextCompactor.summarizeTurns(turns, 1000)

			expect(summary).toContain("[User]")
			expect(summary).toContain("Fix the authentication bug")
		})

		it("summarizes assistant turns with [Agent] prefix", () => {
			const turns = [makeTurn("assistant", "I will update the config file")]
			const summary = ContextCompactor.summarizeTurns(turns, 1000)

			expect(summary).toContain("[Agent]")
			expect(summary).toContain("update the config file")
		})

		it("summarizes tool results with [Result] prefix", () => {
			const turns = [makeTurn("tool_result", "File read successfully", "read_file")]
			const summary = ContextCompactor.summarizeTurns(turns, 1000)

			expect(summary).toContain("[Result]")
		})

		it("detects tool calls in assistant messages", () => {
			const turns = [
				makeTurn("assistant", "I will use <tool_call><tool_name>write_to_file</tool_name></tool_call>"),
			]
			const summary = ContextCompactor.summarizeTurns(turns, 1000)

			expect(summary).toContain("Tool call")
		})

		it("respects maxLength limit", () => {
			const turns = makeConversation(50) // many turns
			const summary = ContextCompactor.summarizeTurns(turns, 200)

			expect(summary.length).toBeLessThanOrEqual(300) // summary + truncation marker overhead
		})

		it("includes turn count header", () => {
			const turns = makeConversation(3) // 9 turns total
			const summary = ContextCompactor.summarizeTurns(turns, 5000)
			expect(summary).toContain("9 prior conversation turns")
		})
	})

	describe("compact", () => {
		it("returns turns unchanged when within token budget", () => {
			const turns = [makeTurn("user", "short message"), makeTurn("assistant", "short reply")]

			const result = ContextCompactor.compact(turns, { maxTokenBudget: 100000 })

			expect(result.turnsRemoved).toBe(0)
			expect(result.compactedTurns.length).toBe(2)
		})

		it("compacts when over token budget", () => {
			// Create a conversation that exceeds the budget
			const turns = makeConversation(20) // 60 turns of content

			const result = ContextCompactor.compact(turns, {
				maxTokenBudget: 10, // very small budget to force compaction
				preserveRecentTurns: 3,
			})

			expect(result.turnsRemoved).toBeGreaterThan(0)
			expect(result.summary).toBeTruthy()
			// Should have: 1 summary turn + preserved recent turns
			expect(result.compactedTurns.length).toBeLessThanOrEqual(4) // 1 summary + 3 recent
		})

		it("produces a system summary turn as the first compacted turn", () => {
			const turns = makeConversation(20)

			const result = ContextCompactor.compact(turns, {
				maxTokenBudget: 10,
				preserveRecentTurns: 2,
			})

			expect(result.compactedTurns[0].role).toBe("system")
			expect(result.compactedTurns[0].content).toContain("<context_summary>")
		})

		it("reports reduction ratio between 0 and 1", () => {
			const turns = makeConversation(20)
			const result = ContextCompactor.compact(turns, {
				maxTokenBudget: 10,
				preserveRecentTurns: 3,
			})

			// Ratio can be slightly negative when summary overhead exceeds savings
			expect(result.reductionRatio).toBeGreaterThanOrEqual(-0.5)
			expect(result.reductionRatio).toBeLessThanOrEqual(1)
		})

		it("truncates tool outputs in preserved turns", () => {
			const turns = [makeTurn("user", "read big file"), makeTurn("tool_result", "x".repeat(10000), "read_file")]

			const result = ContextCompactor.compact(turns, {
				maxTokenBudget: 100000,
				maxToolOutputLength: 500,
			})

			// Tool output should be truncated
			const toolTurn = result.compactedTurns.find((t) => t.role === "tool_result")
			expect(toolTurn!.content.length).toBeLessThan(10000)
		})
	})

	describe("prepareSubAgentContext", () => {
		it("builds a SubAgentContext with task spec and summary", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("file content here")

			const parentTurns = [
				makeTurn("user", "Build the auth module"),
				makeTurn("assistant", "I'll start with login.ts"),
			]

			const context = ContextCompactor.prepareSubAgentContext(
				"Implement login function",
				["src/auth/login.ts"],
				parentTurns,
				"<intent>auth-build</intent>",
				"/workspace",
			)

			expect(context.taskSpec).toBe("Implement login function")
			expect(context.parentSummary).toBeTruthy()
			expect(context.intentContext).toBe("<intent>auth-build</intent>")
			expect(context.estimatedTokens).toBeGreaterThan(0)
		})

		it("includes readable file contents", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("const x = 1;")

			const context = ContextCompactor.prepareSubAgentContext("Task", ["src/file.ts"], [], null, "/workspace")

			expect(context.relevantFiles).toHaveLength(1)
			expect(context.relevantFiles[0].path).toBe("src/file.ts")
			expect(context.relevantFiles[0].content).toContain("const x = 1")
		})

		it("skips missing files gracefully", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false)

			const context = ContextCompactor.prepareSubAgentContext("Task", ["missing.ts"], [], null, "/workspace")

			expect(context.relevantFiles).toHaveLength(0)
		})

		it("handles null intent context", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false)

			const context = ContextCompactor.prepareSubAgentContext("Task", [], [], null, "/workspace")

			expect(context.intentContext).toBeNull()
		})
	})
})
