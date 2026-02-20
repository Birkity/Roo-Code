import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LessonCategory, LessonRecorder } from "../LessonRecorder"
import type { LessonEntry } from "../LessonRecorder"

vi.mock("node:fs")

const CWD = "/workspace"
const BRAIN_PATH = path.join(CWD, "CLAUDE.md")

function makeEntry(overrides: Partial<LessonEntry> = {}): LessonEntry {
	return {
		timestamp: "2025-01-15T10:30:00.000Z",
		category: LessonCategory.LINT_FAILURE,
		intentId: "intent-build-auth",
		trigger: "PostToolHook (ESLint)",
		filePath: "src/auth/login.ts",
		problem: "Missing semicolons (3 errors)",
		lesson: "Always use semicolons in TypeScript files per project config",
		resolution: "Errors fed back to agent for self-correction",
		severity: "error",
		...overrides,
	}
}

const BRAIN_CONTENT_WITH_SECTION = [
	"# CLAUDE.md — Shared Brain",
	"",
	"## Project Rules",
	"",
	"- Follow existing patterns",
	"",
	"## Lessons Learned",
	"",
	"_Automatically recorded by the Hook Engine when verification steps fail._",
	"",
].join("\n")

describe("LessonRecorder", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("formatLesson", () => {
		it("formats a lesson entry as Markdown", () => {
			const entry = makeEntry()
			const formatted = LessonRecorder.formatLesson(entry)

			expect(formatted).toContain("### ❌ LINT_FAILURE")
			expect(formatted).toContain("2025-01-15T10:30:00")
			expect(formatted).toContain("**Intent**: intent-build-auth")
			expect(formatted).toContain("**File**: `src/auth/login.ts`")
			expect(formatted).toContain("**Trigger**: PostToolHook (ESLint)")
			expect(formatted).toContain("**Problem**: Missing semicolons")
			expect(formatted).toContain("**Lesson**: Always use semicolons")
			expect(formatted).toContain("**Resolution**: Errors fed back")
		})

		it("uses warning emoji for warning severity", () => {
			const entry = makeEntry({ severity: "warning" })
			const formatted = LessonRecorder.formatLesson(entry)
			expect(formatted).toContain("### ⚠️")
		})

		it("uses info emoji for info severity", () => {
			const entry = makeEntry({ severity: "info" })
			const formatted = LessonRecorder.formatLesson(entry)
			expect(formatted).toContain("### ℹ️")
		})

		it("omits intent field when null", () => {
			const entry = makeEntry({ intentId: null })
			const formatted = LessonRecorder.formatLesson(entry)
			expect(formatted).not.toContain("**Intent**")
		})

		it("omits file field when null", () => {
			const entry = makeEntry({ filePath: null })
			const formatted = LessonRecorder.formatLesson(entry)
			expect(formatted).not.toContain("**File**")
		})

		it("omits resolution field when null", () => {
			const entry = makeEntry({ resolution: null })
			const formatted = LessonRecorder.formatLesson(entry)
			expect(formatted).not.toContain("**Resolution**")
		})
	})

	describe("record", () => {
		it("creates CLAUDE.md with template if it does not exist", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false)
			vi.mocked(fs.readFileSync).mockReturnValue("")

			LessonRecorder.record(makeEntry(), CWD)

			// Should call writeFileSync to create the file
			expect(fs.writeFileSync).toHaveBeenCalled()
			const createCall = vi.mocked(fs.writeFileSync).mock.calls[0]
			expect(createCall[0]).toBe(BRAIN_PATH)
			const createdContent = createCall[1] as string
			expect(createdContent).toContain("# CLAUDE.md")
			expect(createdContent).toContain("## Lessons Learned")
		})

		it("appends lesson to existing CLAUDE.md", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue(BRAIN_CONTENT_WITH_SECTION)

			LessonRecorder.record(makeEntry(), CWD)

			expect(fs.appendFileSync).toHaveBeenCalled()
		})

		it("adds Lessons Learned section if missing from existing file", () => {
			const contentWithoutSection = "# CLAUDE.md\n\n## Project Rules\n\n- rule 1\n"
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue(contentWithoutSection)

			LessonRecorder.record(makeEntry(), CWD)

			// Should append the section header first
			const appendCalls = vi.mocked(fs.appendFileSync).mock.calls
			expect(appendCalls.length).toBeGreaterThanOrEqual(1)
			const allAppended = appendCalls.map((c) => c[1]).join("")
			expect(allAppended).toContain("## Lessons Learned")
		})

		it("returns success result with entry count", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue(
				BRAIN_CONTENT_WITH_SECTION + "### ❌ LINT_FAILURE — 2025-01-15\n\n- old lesson\n",
			)

			const result = LessonRecorder.record(makeEntry(), CWD)

			expect(result.success).toBe(true)
			expect(result.filePath).toBe(BRAIN_PATH)
			expect(result.entryCount).toBeGreaterThanOrEqual(1)
		})

		it("returns failure result on error", () => {
			vi.mocked(fs.existsSync).mockImplementation(() => {
				throw new Error("Disk full")
			})

			const result = LessonRecorder.record(makeEntry(), CWD)

			expect(result.success).toBe(false)
			expect(result.error).toContain("Disk full")
		})
	})

	describe("recordLintFailure", () => {
		it("records a lint failure with error summary", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue(BRAIN_CONTENT_WITH_SECTION)

			const result = LessonRecorder.recordLintFailure(
				"src/utils.ts",
				[
					{ line: 10, message: "Missing semicolon [semi]" },
					{ line: 20, message: "Unused variable [no-unused-vars]" },
				],
				"intent-42",
				CWD,
			)

			expect(result.success).toBe(true)
			const appendedContent = vi.mocked(fs.appendFileSync).mock.calls[0]?.[1] as string
			expect(appendedContent).toContain("LINT_FAILURE")
			expect(appendedContent).toContain("ESLint")
		})
	})

	describe("recordTestFailure", () => {
		it("records a test failure with stderr", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue(BRAIN_CONTENT_WITH_SECTION)

			const result = LessonRecorder.recordTestFailure(
				"vitest run",
				"FAIL src/__tests__/auth.test.ts\nExpected 200, received 401",
				"intent-99",
				CWD,
			)

			expect(result.success).toBe(true)
		})
	})

	describe("recordScopeViolation", () => {
		it("records a scope violation attempt", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue(BRAIN_CONTENT_WITH_SECTION)

			const result = LessonRecorder.recordScopeViolation(
				"src/core/engine.ts",
				["src/auth/**"],
				"intent-auth",
				CWD,
			)

			expect(result.success).toBe(true)
		})
	})

	describe("recordLockConflict", () => {
		it("records a lock conflict lesson", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue(BRAIN_CONTENT_WITH_SECTION)

			const result = LessonRecorder.recordLockConflict(
				"src/shared.ts",
				"sha256:aaa111",
				"sha256:bbb222",
				"intent-build",
				CWD,
			)

			expect(result.success).toBe(true)
		})
	})

	describe("recordArchitecturalDecision", () => {
		it("records an architectural decision", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue(BRAIN_CONTENT_WITH_SECTION)

			const result = LessonRecorder.recordArchitecturalDecision(
				"Use optimistic locking instead of pessimistic",
				"Non-blocking for concurrent readers",
				"intent-arch",
				CWD,
			)

			expect(result.success).toBe(true)
		})
	})

	describe("LessonCategory", () => {
		it("has all expected categories", () => {
			expect(LessonCategory.LINT_FAILURE).toBe("LINT_FAILURE")
			expect(LessonCategory.TEST_FAILURE).toBe("TEST_FAILURE")
			expect(LessonCategory.BUILD_FAILURE).toBe("BUILD_FAILURE")
			expect(LessonCategory.SCOPE_VIOLATION).toBe("SCOPE_VIOLATION")
			expect(LessonCategory.LOCK_CONFLICT).toBe("LOCK_CONFLICT")
			expect(LessonCategory.ARCHITECTURAL_DECISION).toBe("ARCHITECTURAL_DECISION")
			expect(LessonCategory.STYLE_RULE).toBe("STYLE_RULE")
			expect(LessonCategory.AGENT_INSIGHT).toBe("AGENT_INSIGHT")
		})
	})
})
