import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

// Mock fs and yaml before importing HookEngine
vi.mock("node:fs")
vi.mock("yaml", () => ({
	parse: vi.fn().mockReturnValue({
		active_intents: [],
	}),
}))

// We need a dynamic import approach because HookEngine constructor calls startSession()
// which triggers fs operations. Let's import after mocks are set up.
import { HookEngine } from "../HookEngine"

const mockExistsSync = vi.mocked(fs.existsSync)
const mockReadFileSync = vi.mocked(fs.readFileSync)
const mockWriteFileSync = vi.mocked(fs.writeFileSync)
const mockMkdirSync = vi.mocked(fs.mkdirSync)

const MOCK_CWD = "/test/workspace"
const TASKS_PATH = path.join(MOCK_CWD, ".orchestration", "TASKS.md")
const ORCH_DIR = path.join(MOCK_CWD, ".orchestration")

describe("Session State Management", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Default: .orchestration exists, no TASKS.md
		mockExistsSync.mockReturnValue(false)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("startSession()", () => {
		it("reads TASKS.md at construction (session start)", () => {
			const priorState = "# Prior Session\n- Completed: Phase 1\n- In Progress: Phase 2"
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				return String(p) === TASKS_PATH
			})
			mockReadFileSync.mockReturnValue(priorState)

			const engine = new HookEngine(MOCK_CWD)

			expect(mockExistsSync).toHaveBeenCalledWith(TASKS_PATH)
			expect(mockReadFileSync).toHaveBeenCalledWith(TASKS_PATH, "utf-8")
			expect(engine.getSessionContext()).toBe(priorState)
		})

		it("sets sessionContext to null when TASKS.md does not exist (first session)", () => {
			mockExistsSync.mockReturnValue(false)

			const engine = new HookEngine(MOCK_CWD)

			expect(engine.getSessionContext()).toBeNull()
		})

		it("handles read errors gracefully", () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				return String(p) === TASKS_PATH
			})
			mockReadFileSync.mockImplementation(() => {
				throw new Error("Permission denied")
			})

			// Should not throw
			const engine = new HookEngine(MOCK_CWD)

			expect(engine.getSessionContext()).toBeNull()
		})
	})

	describe("endSession()", () => {
		it("writes session summary to TASKS.md", () => {
			mockExistsSync.mockReturnValue(false)

			const engine = new HookEngine(MOCK_CWD)

			// Mock mkdir and existsSync for the write path
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				return String(p) === ORCH_DIR
			})

			engine.endSession()

			expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
			const [writePath, content] = mockWriteFileSync.mock.calls[0]
			expect(writePath).toBe(TASKS_PATH)

			const written = String(content)
			expect(written).toContain("# Session State")
			expect(written).toContain("## Last Session")
			expect(written).toContain("**Started**")
			expect(written).toContain("**Ended**")
			expect(written).toContain("**Active Intent**: none")
		})

		it("includes optional summary text", () => {
			mockExistsSync.mockReturnValue(false)
			const engine = new HookEngine(MOCK_CWD)

			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				return String(p) === ORCH_DIR
			})

			engine.endSession("Completed Phase 4 implementation")

			const [, content] = mockWriteFileSync.mock.calls[0]
			const written = String(content)
			expect(written).toContain("## Summary")
			expect(written).toContain("Completed Phase 4 implementation")
		})

		it("creates .orchestration directory if it does not exist", () => {
			mockExistsSync.mockReturnValue(false)

			const engine = new HookEngine(MOCK_CWD)
			engine.endSession()

			expect(mockMkdirSync).toHaveBeenCalledWith(ORCH_DIR, { recursive: true })
		})

		it("handles write errors gracefully", () => {
			mockExistsSync.mockReturnValue(false)
			const engine = new HookEngine(MOCK_CWD)

			mockWriteFileSync.mockImplementation(() => {
				throw new Error("Disk full")
			})

			// Should not throw
			expect(() => engine.endSession()).not.toThrow()
		})
	})

	describe("getSessionContext()", () => {
		it("returns prior session content when TASKS.md existed", () => {
			const prior = "# Tasks\n- Fix auth bug\n- Add tests"
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				return String(p) === TASKS_PATH
			})
			mockReadFileSync.mockReturnValue(prior)

			const engine = new HookEngine(MOCK_CWD)

			expect(engine.getSessionContext()).toBe(prior)
		})

		it("returns null when no prior session exists", () => {
			mockExistsSync.mockReturnValue(false)

			const engine = new HookEngine(MOCK_CWD)

			expect(engine.getSessionContext()).toBeNull()
		})
	})

	describe("session round-trip", () => {
		it("writes state that can be read by next session", () => {
			// Session 1: No prior state, write end-of-session
			mockExistsSync.mockReturnValue(false)
			const engine1 = new HookEngine(MOCK_CWD)

			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				return String(p) === ORCH_DIR
			})
			engine1.endSession("Finished Phase 1")

			// Capture what was written
			const [, writtenContent] = mockWriteFileSync.mock.calls[0]
			const written = String(writtenContent)

			// Session 2: Read what Session 1 wrote
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				return String(p) === TASKS_PATH
			})
			mockReadFileSync.mockReturnValue(written)

			const engine2 = new HookEngine(MOCK_CWD)

			const context = engine2.getSessionContext()
			expect(context).not.toBeNull()
			expect(context).toContain("# Session State")
			expect(context).toContain("Finished Phase 1")
		})
	})
})
