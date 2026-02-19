/**
 * TraceLogger.test.ts — Tests for Phase 3 Agent Trace serialization:
 * Schema compliance, intent ID injection, content hashing, JSONL persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { TraceLogger } from "../TraceLogger"
import type { TraceInput, AgentTraceRecord } from "../TraceLogger"
import { MutationClass } from "../SemanticClassifier"

// Mock simple-git
vi.mock("simple-git", () => ({
	default: () => ({
		revparse: vi.fn().mockResolvedValue("abc123def456"),
	}),
}))

// Mock uuid
vi.mock("uuid", () => ({
	v4: () => "test-uuid-1234-5678",
}))

describe("TraceLogger", () => {
	const testCwd = path.join(process.cwd(), "__test_workspace__")
	const traceFilePath = path.join(testCwd, ".orchestration", "agent_trace.jsonl")

	beforeEach(() => {
		// Create test workspace
		const orchestrationDir = path.join(testCwd, ".orchestration")
		if (!fs.existsSync(orchestrationDir)) {
			fs.mkdirSync(orchestrationDir, { recursive: true })
		}
		// Clean trace file
		if (fs.existsSync(traceFilePath)) {
			fs.unlinkSync(traceFilePath)
		}
	})

	afterEach(() => {
		// Clean up
		if (fs.existsSync(traceFilePath)) {
			fs.unlinkSync(traceFilePath)
		}
		// Clean up directories
		const orchestrationDir = path.join(testCwd, ".orchestration")
		if (fs.existsSync(orchestrationDir)) {
			fs.rmSync(orchestrationDir, { recursive: true, force: true })
		}
		if (fs.existsSync(testCwd)) {
			fs.rmSync(testCwd, { recursive: true, force: true })
		}
	})

	describe("recordTrace", () => {
		it("creates a valid Agent Trace JSON record", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/auth/middleware.ts", content: "new content" },
				filePath: "src/auth/middleware.ts",
				oldContent: "",
				newContent: 'export function auth() { return "jwt"; }',
				activeIntentId: "INT-001",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)

			expect(result.success).toBe(true)
			expect(result.record).not.toBeNull()

			const record = result.record!
			expect(record.id).toBe("test-uuid-1234-5678")
			expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
			expect(record.vcs.revision_id).toBe("abc123def456")
			expect(record.files).toHaveLength(1)
		})

		it("injects Intent ID into the related array (golden thread)", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/auth/jwt.ts" },
				filePath: "src/auth/jwt.ts",
				oldContent: "",
				newContent: "export const jwt = true;",
				activeIntentId: "INT-001",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)
			const related = result.record!.files[0].conversations[0].related

			expect(related).toHaveLength(1)
			expect(related[0].type).toBe("specification")
			expect(related[0].value).toBe("INT-001")
		})

		it("injects content_hash into the ranges object", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/utils.ts" },
				filePath: "src/utils.ts",
				oldContent: "",
				newContent: "export const utils = true;",
				activeIntentId: "INT-001",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)
			const range = result.record!.files[0].conversations[0].ranges[0]

			expect(range.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
			expect(range.start_line).toBe(1)
			expect(range.end_line).toBeGreaterThan(0)
		})

		it("classifies new file as INTENT_EVOLUTION", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/new-feature.ts" },
				filePath: "src/new-feature.ts",
				oldContent: "",
				newContent: "export function newFeature() { return 42; }",
				activeIntentId: "INT-001",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)

			expect(result.classification!.mutationClass).toBe(MutationClass.INTENT_EVOLUTION)
			expect(result.record!.mutation.mutation_class).toBe("INTENT_EVOLUTION")
		})

		it("classifies rename as AST_REFACTOR", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/util.ts" },
				filePath: "src/util.ts",
				oldContent: "const oldName = 42;\nconsole.log(oldName);",
				newContent: "const newName = 42;\nconsole.log(newName);",
				activeIntentId: "INT-001",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)

			expect(result.classification!.mutationClass).toBe(MutationClass.AST_REFACTOR)
			expect(result.record!.mutation.mutation_class).toBe("AST_REFACTOR")
		})

		it("uses agent-provided mutation_class when available", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/util.ts" },
				filePath: "src/util.ts",
				oldContent: "const a = 1;",
				newContent: "const b = 1;",
				activeIntentId: "INT-001",
				agentMutationClass: "INTENT_EVOLUTION",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)

			expect(result.record!.mutation.mutation_class).toBe("INTENT_EVOLUTION")
		})

		it("appends JSONL to agent_trace.jsonl", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/test.ts" },
				filePath: "src/test.ts",
				oldContent: "",
				newContent: "const x = 1;",
				activeIntentId: "INT-001",
			}

			await TraceLogger.recordTrace(input, testCwd)

			expect(fs.existsSync(traceFilePath)).toBe(true)
			const content = fs.readFileSync(traceFilePath, "utf-8")
			const lines = content.trim().split("\n")
			expect(lines).toHaveLength(1)

			// Verify it's valid JSON
			const parsed = JSON.parse(lines[0]) as AgentTraceRecord
			expect(parsed.id).toBe("test-uuid-1234-5678")
			expect(parsed.files[0].relative_path).toBe("src/test.ts")
		})

		it("appends multiple traces to the same file", async () => {
			const baseInput: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/test.ts" },
				filePath: "src/test.ts",
				oldContent: "",
				newContent: "const x = 1;",
				activeIntentId: "INT-001",
			}

			await TraceLogger.recordTrace(baseInput, testCwd)
			await TraceLogger.recordTrace({ ...baseInput, filePath: "src/test2.ts" }, testCwd)

			const content = fs.readFileSync(traceFilePath, "utf-8")
			const lines = content.trim().split("\n")
			expect(lines).toHaveLength(2)
		})

		it("handles missing activeIntentId gracefully", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/test.ts" },
				filePath: "src/test.ts",
				oldContent: "",
				newContent: "const x = 1;",
				activeIntentId: null,
			}

			const result = await TraceLogger.recordTrace(input, testCwd)

			expect(result.success).toBe(true)
			const related = result.record!.files[0].conversations[0].related
			expect(related).toHaveLength(0)
		})

		it("produces trace feedback for AI context", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/auth.ts" },
				filePath: "src/auth.ts",
				oldContent: "",
				newContent: "export function auth() {}",
				activeIntentId: "INT-001",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)

			expect(result.feedback).toContain("<trace_recorded>")
			expect(result.feedback).toContain("</trace_recorded>")
			expect(result.feedback).toContain("INT-001")
			expect(result.feedback).toContain("INTENT_EVOLUTION")
			expect(result.feedback).toContain("sha256:")
		})
	})

	describe("normalizeFilePath", () => {
		it("normalizes backslashes in trace record file paths", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/test.ts" },
				filePath: String.raw`src\auth\middleware.ts`,
				oldContent: "",
				newContent: "export const x = 1;",
				activeIntentId: "INT-001",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)
			expect(result.record!.files[0].relative_path).toBe("src/auth/middleware.ts")
		})

		it("strips leading ./ from file paths", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/test.ts" },
				filePath: "./src/auth.ts",
				oldContent: "",
				newContent: "export const x = 1;",
				activeIntentId: "INT-001",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)
			expect(result.record!.files[0].relative_path).toBe("src/auth.ts")
		})
	})

	describe("readOldContent", () => {
		it("returns empty string for non-existent files", () => {
			const content = TraceLogger.readOldContent("nonexistent.ts", testCwd)
			expect(content).toBe("")
		})

		it("reads existing file content", () => {
			const testFile = path.join(testCwd, "existing.ts")
			fs.writeFileSync(testFile, "const existing = true;", "utf-8")

			const content = TraceLogger.readOldContent("existing.ts", testCwd)
			expect(content).toBe("const existing = true;")

			// Clean up
			fs.unlinkSync(testFile)
		})
	})

	describe("Agent Trace Schema compliance", () => {
		it("contains all required top-level fields", async () => {
			const input: TraceInput = {
				toolName: "write_to_file",
				params: { path: "src/test.ts" },
				filePath: "src/test.ts",
				oldContent: "",
				newContent: "const x = 1;",
				activeIntentId: "INT-001",
			}

			const result = await TraceLogger.recordTrace(input, testCwd)
			const record = result.record!

			// Top-level required fields per Agent Trace spec
			expect(record).toHaveProperty("id")
			expect(record).toHaveProperty("timestamp")
			expect(record).toHaveProperty("vcs")
			expect(record).toHaveProperty("files")

			// VCS metadata
			expect(record.vcs).toHaveProperty("revision_id")

			// Files array
			expect(record.files[0]).toHaveProperty("relative_path")
			expect(record.files[0]).toHaveProperty("conversations")

			// Conversation
			const conv = record.files[0].conversations[0]
			expect(conv).toHaveProperty("url")
			expect(conv).toHaveProperty("contributor")
			expect(conv).toHaveProperty("ranges")
			expect(conv).toHaveProperty("related")

			// Contributor
			expect(conv.contributor).toHaveProperty("entity_type")
			expect(conv.contributor).toHaveProperty("model_identifier")
			expect(conv.contributor.entity_type).toBe("AI")

			// Range
			expect(conv.ranges[0]).toHaveProperty("start_line")
			expect(conv.ranges[0]).toHaveProperty("end_line")
			expect(conv.ranges[0]).toHaveProperty("content_hash")

			// Phase 3 extension: mutation metadata
			expect(record).toHaveProperty("mutation")
			expect(record.mutation).toHaveProperty("mutation_class")
			expect(record.mutation).toHaveProperty("score")
			expect(record.mutation).toHaveProperty("reasoning")
		})
	})
})
