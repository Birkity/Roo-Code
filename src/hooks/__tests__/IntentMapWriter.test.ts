import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

import { IntentMapWriter } from "../IntentMapWriter"
import type { IntentMap, IntentMapSection, IntentMapFileEntry, IntentMapUpdateResult } from "../IntentMapWriter"
import type { AgentTraceRecord } from "../TraceLogger"
import { MutationClass } from "../SemanticClassifier"

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_CWD = path.join(process.cwd(), "__test_intent_map__")
const ORCH_DIR = path.join(TEST_CWD, ".orchestration")
const MAP_PATH = path.join(ORCH_DIR, "intent_map.md")
const TRACE_PATH = path.join(ORCH_DIR, "agent_trace.jsonl")
const INTENTS_PATH = path.join(ORCH_DIR, "active_intents.yaml")

function makeTrace(overrides: Partial<AgentTraceRecord> = {}): AgentTraceRecord {
	return {
		id: "trace-uuid-001",
		timestamp: "2026-02-16T12:00:00.000Z",
		vcs: { revision_id: "abc123def456" },
		files: [
			{
				relative_path: "src/auth/middleware.ts",
				conversations: [
					{
						url: "local://session-1",
						contributor: { entity_type: "AI", model_identifier: "claude-3-5-sonnet" },
						ranges: [
							{ start_line: 1, end_line: 45, content_hash: "sha256:a8f5f167f44f4964e6c998dee827110c" },
						],
						related: [{ type: "specification", value: "INT-001" }],
					},
				],
			},
		],
		mutation: {
			mutation_class: MutationClass.INTENT_EVOLUTION,
			score: 0.72,
			reasoning: "New exports detected",
		},
		...overrides,
	}
}

function makeRefactorTrace(): AgentTraceRecord {
	return makeTrace({
		mutation: {
			mutation_class: MutationClass.AST_REFACTOR,
			score: 0.15,
			reasoning: "Minor restructuring",
		},
	})
}

const SAMPLE_INTENTS_YAML = `active_intents:
  - id: "INT-001"
    name: "JWT Authentication Migration"
    status: "IN_PROGRESS"
    owned_scope:
      - "src/auth/**"
    constraints:
      - "Must not use external auth providers"
    acceptance_criteria:
      - "Unit tests in tests/auth/ pass"

  - id: "INT-002"
    name: "Refactor Auth Middleware"
    status: "IN_PROGRESS"
    owned_scope:
      - "src/middleware/**"
    constraints:
      - "Must follow SRP"
    acceptance_criteria:
      - "All middleware tests pass"
`

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
	if (!fs.existsSync(ORCH_DIR)) {
		fs.mkdirSync(ORCH_DIR, { recursive: true })
	}
})

afterEach(() => {
	if (fs.existsSync(TEST_CWD)) {
		fs.rmSync(TEST_CWD, { recursive: true, force: true })
	}
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe("IntentMapWriter", () => {
	// ── extractIntentId ──────────────────────────────────────────────────

	describe("extractIntentId", () => {
		it("extracts intent ID from the related array", () => {
			const trace = makeTrace()
			expect(IntentMapWriter.extractIntentId(trace)).toBe("INT-001")
		})

		it("returns null when no related entries exist", () => {
			const trace = makeTrace()
			trace.files[0].conversations[0].related = []
			expect(IntentMapWriter.extractIntentId(trace)).toBeNull()
		})

		it("returns null for empty files array", () => {
			const trace = makeTrace()
			trace.files = []
			expect(IntentMapWriter.extractIntentId(trace)).toBeNull()
		})

		it("skips non-specification related types", () => {
			const trace = makeTrace()
			trace.files[0].conversations[0].related = [{ type: "ticket", value: "JIRA-100" }]
			expect(IntentMapWriter.extractIntentId(trace)).toBeNull()
		})
	})

	// ── traceToEntries ──────────────────────────────────────────────────

	describe("traceToEntries", () => {
		it("converts a trace record to file entries", () => {
			const trace = makeTrace()
			const entries = IntentMapWriter.traceToEntries(trace)

			expect(entries).toHaveLength(1)
			expect(entries[0]).toMatchObject({
				relativePath: "src/auth/middleware.ts",
				contentHash: "sha256:a8f5f167f44f4964e6c998dee827110c",
				startLine: 1,
				endLine: 45,
				mutationClass: MutationClass.INTENT_EVOLUTION,
				gitSha: "abc123def456",
			})
		})

		it("handles multiple files in a single trace", () => {
			const trace = makeTrace()
			trace.files.push({
				relative_path: "src/auth/jwt.ts",
				conversations: [
					{
						url: "local://session-1",
						contributor: { entity_type: "AI", model_identifier: "claude-3-5-sonnet" },
						ranges: [{ start_line: 1, end_line: 30, content_hash: "sha256:deadbeef" }],
						related: [{ type: "specification", value: "INT-001" }],
					},
				],
			})

			const entries = IntentMapWriter.traceToEntries(trace)
			expect(entries).toHaveLength(2)
			expect(entries[1].relativePath).toBe("src/auth/jwt.ts")
		})

		it("handles multiple ranges in a single conversation", () => {
			const trace = makeTrace()
			trace.files[0].conversations[0].ranges.push({
				start_line: 50,
				end_line: 80,
				content_hash: "sha256:secondrange",
			})

			const entries = IntentMapWriter.traceToEntries(trace)
			expect(entries).toHaveLength(2)
		})
	})

	// ── mergeEntries ────────────────────────────────────────────────────

	describe("mergeEntries", () => {
		it("creates a new section for a new intent", () => {
			const map: IntentMap = { sections: [] }
			const entry: IntentMapFileEntry = {
				relativePath: "src/auth/middleware.ts",
				contentHash: "sha256:abc",
				startLine: 1,
				endLine: 45,
				mutationClass: MutationClass.INTENT_EVOLUTION,
				lastUpdated: "2026-02-16T12:00:00Z",
				gitSha: "abc123",
			}

			IntentMapWriter.mergeEntries(map, "INT-001", [entry])

			expect(map.sections).toHaveLength(1)
			expect(map.sections[0].intentId).toBe("INT-001")
			expect(map.sections[0].files).toHaveLength(1)
		})

		it("upserts existing file entry for same path", () => {
			const map: IntentMap = {
				sections: [
					{
						intentId: "INT-001",
						intentName: "JWT Auth",
						files: [
							{
								relativePath: "src/auth/middleware.ts",
								contentHash: "sha256:old",
								startLine: 1,
								endLine: 30,
								mutationClass: MutationClass.INTENT_EVOLUTION,
								lastUpdated: "2026-02-15T10:00:00Z",
								gitSha: "old123",
							},
						],
					},
				],
			}

			const updatedEntry: IntentMapFileEntry = {
				relativePath: "src/auth/middleware.ts",
				contentHash: "sha256:new",
				startLine: 1,
				endLine: 45,
				mutationClass: MutationClass.INTENT_EVOLUTION,
				lastUpdated: "2026-02-16T12:00:00Z",
				gitSha: "new456",
			}

			IntentMapWriter.mergeEntries(map, "INT-001", [updatedEntry])

			expect(map.sections[0].files).toHaveLength(1)
			expect(map.sections[0].files[0].contentHash).toBe("sha256:new")
			expect(map.sections[0].files[0].endLine).toBe(45)
		})

		it("appends new files under existing intent", () => {
			const map: IntentMap = {
				sections: [
					{
						intentId: "INT-001",
						intentName: "JWT Auth",
						files: [
							{
								relativePath: "src/auth/middleware.ts",
								contentHash: "sha256:abc",
								startLine: 1,
								endLine: 45,
								mutationClass: MutationClass.INTENT_EVOLUTION,
								lastUpdated: "2026-02-16T12:00:00Z",
								gitSha: "abc123",
							},
						],
					},
				],
			}

			const newEntry: IntentMapFileEntry = {
				relativePath: "src/auth/jwt.ts",
				contentHash: "sha256:def",
				startLine: 1,
				endLine: 30,
				mutationClass: MutationClass.INTENT_EVOLUTION,
				lastUpdated: "2026-02-16T12:30:00Z",
				gitSha: "def456",
			}

			IntentMapWriter.mergeEntries(map, "INT-001", [newEntry])

			expect(map.sections[0].files).toHaveLength(2)
		})

		it("sorts files alphabetically within a section", () => {
			const map: IntentMap = { sections: [] }

			IntentMapWriter.mergeEntries(map, "INT-001", [
				{
					relativePath: "src/z-file.ts",
					contentHash: "sha256:z",
					startLine: 1,
					endLine: 10,
					mutationClass: MutationClass.INTENT_EVOLUTION,
					lastUpdated: "2026-02-16T12:00:00Z",
					gitSha: "z123",
				},
				{
					relativePath: "src/a-file.ts",
					contentHash: "sha256:a",
					startLine: 1,
					endLine: 10,
					mutationClass: MutationClass.INTENT_EVOLUTION,
					lastUpdated: "2026-02-16T12:00:00Z",
					gitSha: "a123",
				},
			])

			expect(map.sections[0].files[0].relativePath).toBe("src/a-file.ts")
			expect(map.sections[0].files[1].relativePath).toBe("src/z-file.ts")
		})
	})

	// ── parseIntentNames ────────────────────────────────────────────────

	describe("parseIntentNames", () => {
		it("extracts id → name mappings from YAML", () => {
			const names = IntentMapWriter.parseIntentNames(SAMPLE_INTENTS_YAML)

			expect(names.get("INT-001")).toBe("JWT Authentication Migration")
			expect(names.get("INT-002")).toBe("Refactor Auth Middleware")
		})

		it("returns empty map for empty content", () => {
			const names = IntentMapWriter.parseIntentNames("")
			expect(names.size).toBe(0)
		})
	})

	// ── serializeMap / parseMapContent round-trip ────────────────────────

	describe("serialization", () => {
		it("serializes an empty map", () => {
			const map: IntentMap = { sections: [] }
			const md = IntentMapWriter.serializeMap(map)

			expect(md).toContain("# Intent Map — Spatial Index")
			expect(md).toContain("No intent-file mappings recorded yet")
		})

		it("serializes a map with one section", () => {
			const map: IntentMap = {
				sections: [
					{
						intentId: "INT-001",
						intentName: "JWT Authentication Migration",
						files: [
							{
								relativePath: "src/auth/middleware.ts",
								contentHash: "sha256:a8f5f167f44f4964e6c998dee827110c",
								startLine: 1,
								endLine: 45,
								mutationClass: MutationClass.INTENT_EVOLUTION,
								lastUpdated: "2026-02-16T12:00:00.000Z",
								gitSha: "abc123def456",
							},
						],
					},
				],
			}

			const md = IntentMapWriter.serializeMap(map)

			expect(md).toContain("## INT-001: JWT Authentication Migration")
			expect(md).toContain("| File | Content Hash | Lines | Mutation | Git SHA | Last Updated |")
			expect(md).toContain("`src/auth/middleware.ts`")
			expect(md).toContain("1–45")
			expect(md).toContain("INTENT_EVOLUTION")
			expect(md).toContain("`abc123de`")
		})

		it("sorts sections by intent ID", () => {
			const map: IntentMap = {
				sections: [
					{ intentId: "INT-003", intentName: "Third", files: [] },
					{ intentId: "INT-001", intentName: "First", files: [] },
					{ intentId: "INT-002", intentName: "Second", files: [] },
				],
			}

			const md = IntentMapWriter.serializeMap(map)
			const idx1 = md.indexOf("INT-001")
			const idx2 = md.indexOf("INT-002")
			const idx3 = md.indexOf("INT-003")

			expect(idx1).toBeLessThan(idx2)
			expect(idx2).toBeLessThan(idx3)
		})

		it("round-trips: serialize → parse preserves data", () => {
			const original: IntentMap = {
				sections: [
					{
						intentId: "INT-001",
						intentName: "JWT Auth",
						files: [
							{
								relativePath: "src/auth/middleware.ts",
								contentHash: "sha256:abcdef1234567890",
								startLine: 1,
								endLine: 45,
								mutationClass: MutationClass.INTENT_EVOLUTION,
								lastUpdated: "2026-02-16T12:00:00",
								gitSha: "abc12345",
							},
							{
								relativePath: "src/auth/jwt.ts",
								contentHash: "sha256:fedcba0987654321",
								startLine: 10,
								endLine: 80,
								mutationClass: MutationClass.INTENT_EVOLUTION,
								lastUpdated: "2026-02-16T13:00:00",
								gitSha: "def45678",
							},
						],
					},
				],
			}

			const md = IntentMapWriter.serializeMap(original)
			const parsed = IntentMapWriter.parseMapContent(md)

			expect(parsed.sections).toHaveLength(1)
			expect(parsed.sections[0].intentId).toBe("INT-001")
			expect(parsed.sections[0].intentName).toBe("JWT Auth")
			expect(parsed.sections[0].files).toHaveLength(2)
			expect(parsed.sections[0].files[0].relativePath).toBe("src/auth/middleware.ts")
			expect(parsed.sections[0].files[0].startLine).toBe(1)
			expect(parsed.sections[0].files[0].endLine).toBe(45)
			expect(parsed.sections[0].files[1].relativePath).toBe("src/auth/jwt.ts")
		})
	})

	// ── update (incremental) ────────────────────────────────────────────

	describe("update", () => {
		it("creates intent_map.md on first INTENT_EVOLUTION", () => {
			const trace = makeTrace()
			const result = IntentMapWriter.update(trace, TEST_CWD)

			expect(result.success).toBe(true)
			expect(result.isNewFile).toBe(true)
			expect(result.intentCount).toBe(1)
			expect(result.fileEntryCount).toBe(1)
			expect(fs.existsSync(MAP_PATH)).toBe(true)

			const content = fs.readFileSync(MAP_PATH, "utf-8")
			expect(content).toContain("INT-001")
			expect(content).toContain("src/auth/middleware.ts")
		})

		it("skips update on AST_REFACTOR mutations", () => {
			const trace = makeRefactorTrace()
			const result = IntentMapWriter.update(trace, TEST_CWD)

			expect(result.success).toBe(true)
			expect(result.fileEntryCount).toBe(0)
			expect(fs.existsSync(MAP_PATH)).toBe(false)
		})

		it("skips update when no intent is linked (no related)", () => {
			const trace = makeTrace()
			trace.files[0].conversations[0].related = []
			const result = IntentMapWriter.update(trace, TEST_CWD)

			expect(result.success).toBe(true)
			expect(result.fileEntryCount).toBe(0)
		})

		it("incrementally adds new files to existing intent", () => {
			// First write
			IntentMapWriter.update(makeTrace(), TEST_CWD)

			// Second write — different file, same intent
			const trace2 = makeTrace({
				id: "trace-uuid-002",
				timestamp: "2026-02-16T13:00:00.000Z",
				files: [
					{
						relative_path: "src/auth/jwt.ts",
						conversations: [
							{
								url: "local://session-2",
								contributor: { entity_type: "AI", model_identifier: "claude-3-5-sonnet" },
								ranges: [{ start_line: 1, end_line: 30, content_hash: "sha256:deadbeefcafe" }],
								related: [{ type: "specification", value: "INT-001" }],
							},
						],
					},
				],
			})

			const result = IntentMapWriter.update(trace2, TEST_CWD)

			expect(result.success).toBe(true)
			expect(result.intentCount).toBe(1)
			expect(result.fileEntryCount).toBe(2)

			const content = fs.readFileSync(MAP_PATH, "utf-8")
			expect(content).toContain("src/auth/middleware.ts")
			expect(content).toContain("src/auth/jwt.ts")
		})

		it("upserts file entry when same file is modified again", () => {
			// First write
			IntentMapWriter.update(makeTrace(), TEST_CWD)

			// Second write — same file, updated hash
			const trace2 = makeTrace({
				id: "trace-uuid-002",
				timestamp: "2026-02-16T14:00:00.000Z",
				files: [
					{
						relative_path: "src/auth/middleware.ts",
						conversations: [
							{
								url: "local://session-2",
								contributor: { entity_type: "AI", model_identifier: "claude-3-5-sonnet" },
								ranges: [{ start_line: 1, end_line: 60, content_hash: "sha256:updatedhash123" }],
								related: [{ type: "specification", value: "INT-001" }],
							},
						],
					},
				],
			})

			const result = IntentMapWriter.update(trace2, TEST_CWD)

			expect(result.fileEntryCount).toBe(1) // Still 1 file, upserted
			const content = fs.readFileSync(MAP_PATH, "utf-8")
			expect(content).toContain("sha256:updatedhash1")
			expect(content).not.toContain("sha256:a8f5f167f44f49")
		})

		it("handles multiple intents in the same map", () => {
			// INT-001
			IntentMapWriter.update(makeTrace(), TEST_CWD)

			// INT-002
			const trace2 = makeTrace({
				id: "trace-uuid-003",
				files: [
					{
						relative_path: "src/middleware/rate-limiter.ts",
						conversations: [
							{
								url: "local://session-3",
								contributor: { entity_type: "AI", model_identifier: "claude-3-5-sonnet" },
								ranges: [{ start_line: 1, end_line: 25, content_hash: "sha256:ratelimithash" }],
								related: [{ type: "specification", value: "INT-002" }],
							},
						],
					},
				],
			})

			const result = IntentMapWriter.update(trace2, TEST_CWD)

			expect(result.intentCount).toBe(2)
			const content = fs.readFileSync(MAP_PATH, "utf-8")
			expect(content).toContain("INT-001")
			expect(content).toContain("INT-002")
		})

		it("resolves intent names from active_intents.yaml", () => {
			fs.writeFileSync(INTENTS_PATH, SAMPLE_INTENTS_YAML, "utf-8")

			IntentMapWriter.update(makeTrace(), TEST_CWD)

			const content = fs.readFileSync(MAP_PATH, "utf-8")
			expect(content).toContain("INT-001: JWT Authentication Migration")
		})

		it("falls back to intent ID when active_intents.yaml is missing", () => {
			IntentMapWriter.update(makeTrace(), TEST_CWD)

			const content = fs.readFileSync(MAP_PATH, "utf-8")
			expect(content).toContain("## INT-001: INT-001")
		})
	})

	// ── regenerate ──────────────────────────────────────────────────────

	describe("regenerate", () => {
		it("rebuilds map from agent_trace.jsonl", () => {
			// Write trace records manually
			const traces = [
				makeTrace(),
				makeTrace({
					id: "trace-uuid-002",
					timestamp: "2026-02-16T13:00:00.000Z",
					files: [
						{
							relative_path: "src/auth/jwt.ts",
							conversations: [
								{
									url: "local://session-2",
									contributor: { entity_type: "AI", model_identifier: "claude-3-5-sonnet" },
									ranges: [{ start_line: 1, end_line: 30, content_hash: "sha256:jwtfilehash" }],
									related: [{ type: "specification", value: "INT-001" }],
								},
							],
						},
					],
				}),
			]

			const jsonlContent = traces.map((t) => JSON.stringify(t)).join("\n") + "\n"
			fs.writeFileSync(TRACE_PATH, jsonlContent, "utf-8")

			const result = IntentMapWriter.regenerate(TEST_CWD)

			expect(result.success).toBe(true)
			expect(result.intentCount).toBe(1)
			expect(result.fileEntryCount).toBe(2)
			expect(fs.existsSync(MAP_PATH)).toBe(true)
		})

		it("skips AST_REFACTOR traces during regeneration", () => {
			const traces = [makeTrace(), makeRefactorTrace()]
			const jsonlContent = traces.map((t) => JSON.stringify(t)).join("\n") + "\n"
			fs.writeFileSync(TRACE_PATH, jsonlContent, "utf-8")

			const result = IntentMapWriter.regenerate(TEST_CWD)

			expect(result.fileEntryCount).toBe(1)
		})

		it("returns error when agent_trace.jsonl does not exist", () => {
			const result = IntentMapWriter.regenerate(TEST_CWD)

			expect(result.success).toBe(false)
			expect(result.error).toContain("agent_trace.jsonl not found")
		})

		it("skips malformed JSONL lines", () => {
			const content = [
				JSON.stringify(makeTrace()),
				"this is not valid json",
				JSON.stringify(
					makeTrace({
						id: "trace-uuid-003",
						files: [
							{
								relative_path: "src/auth/other.ts",
								conversations: [
									{
										url: "local://s3",
										contributor: { entity_type: "AI", model_identifier: "model" },
										ranges: [{ start_line: 1, end_line: 10, content_hash: "sha256:other" }],
										related: [{ type: "specification", value: "INT-001" }],
									},
								],
							},
						],
					}),
				),
			].join("\n")

			fs.writeFileSync(TRACE_PATH, content, "utf-8")

			const result = IntentMapWriter.regenerate(TEST_CWD)
			expect(result.success).toBe(true)
			expect(result.fileEntryCount).toBe(2) // Skipped the bad line
		})

		it("resolves intent names during regeneration", () => {
			fs.writeFileSync(INTENTS_PATH, SAMPLE_INTENTS_YAML, "utf-8")
			fs.writeFileSync(TRACE_PATH, JSON.stringify(makeTrace()) + "\n", "utf-8")

			IntentMapWriter.regenerate(TEST_CWD)

			const content = fs.readFileSync(MAP_PATH, "utf-8")
			expect(content).toContain("JWT Authentication Migration")
		})
	})

	// ── parseMap (reading existing file) ────────────────────────────────

	describe("parseMap", () => {
		it("returns empty map when file does not exist", () => {
			const map = IntentMapWriter.parseMap(MAP_PATH)
			expect(map.sections).toHaveLength(0)
		})

		it("parses an existing intent_map.md file", () => {
			// Create a map first
			const trace = makeTrace()
			IntentMapWriter.update(trace, TEST_CWD)

			// Parse it back
			const map = IntentMapWriter.parseMap(MAP_PATH)
			expect(map.sections.length).toBeGreaterThanOrEqual(1)
			expect(map.sections[0].intentId).toBe("INT-001")
			expect(map.sections[0].files.length).toBeGreaterThanOrEqual(1)
		})
	})

	// ── Edge cases ──────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("creates .orchestration/ directory if missing", () => {
			fs.rmSync(ORCH_DIR, { recursive: true, force: true })

			const trace = makeTrace()
			const result = IntentMapWriter.update(trace, TEST_CWD)

			expect(result.success).toBe(true)
			expect(fs.existsSync(MAP_PATH)).toBe(true)
		})

		it("handles trace with empty files array gracefully", () => {
			const trace = makeTrace()
			trace.files = []
			const result = IntentMapWriter.update(trace, TEST_CWD)

			expect(result.success).toBe(true)
			expect(result.fileEntryCount).toBe(0)
		})

		it("content hash truncation in output does not lose data on re-read", () => {
			// Write with a long hash
			const trace = makeTrace()
			trace.files[0].conversations[0].ranges[0].content_hash =
				"sha256:a8f5f167f44f4964e6c998dee827110cabcdef01234567890"
			IntentMapWriter.update(trace, TEST_CWD)

			// The file should contain the truncated hash (20 chars + ellipsis)
			const content = fs.readFileSync(MAP_PATH, "utf-8")
			expect(content).toContain("sha256:a8f5f167f44f4")
			expect(content).toContain("…")
		})
	})
})
