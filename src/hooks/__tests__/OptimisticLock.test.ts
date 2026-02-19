import * as fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { OptimisticLockManager } from "../OptimisticLock"
import type { LockValidationResult } from "../OptimisticLock"

vi.mock("node:fs")

const CWD = "/workspace"

function mockFileContent(content: string) {
	vi.mocked(fs.existsSync).mockReturnValue(true)
	vi.mocked(fs.readFileSync).mockReturnValue(content)
}

function mockFileDeleted() {
	vi.mocked(fs.existsSync).mockReturnValue(false)
}

function mockFileExistsThenReturns(content: string) {
	vi.mocked(fs.existsSync).mockReturnValue(true)
	vi.mocked(fs.readFileSync).mockReturnValue(content)
}

describe("OptimisticLockManager", () => {
	let manager: OptimisticLockManager

	beforeEach(() => {
		vi.clearAllMocks()
		manager = new OptimisticLockManager(CWD)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("captureReadHash", () => {
		it("captures hash for an existing file", () => {
			mockFileContent("function hello() { return 42; }")
			const snap = manager.captureReadHash("src/index.ts")

			expect(snap).not.toBeNull()
			expect(snap!.relativePath).toBe("src/index.ts")
			expect(snap!.hash).toMatch(/^sha256:[a-f0-9]{64}$/)
			expect(snap!.capturedAt).toBeTruthy()
		})

		it("returns null for a non-existent file", () => {
			mockFileDeleted()
			const snap = manager.captureReadHash("missing.ts")
			expect(snap).toBeNull()
		})

		it("stores agentId on the snapshot when provided", () => {
			mockFileContent("content")
			const snap = manager.captureReadHash("file.ts", "agent-42")
			expect(snap!.agentId).toBe("agent-42")
		})

		it("produces deterministic hashes for same content", () => {
			mockFileContent("const x = 1;")
			const hash1 = manager.captureReadHash("a.ts")!.hash

			const manager2 = new OptimisticLockManager(CWD)
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("const x = 1;")
			const hash2 = manager2.captureReadHash("b.ts")!.hash

			expect(hash1).toBe(hash2)
		})

		it("adds to trackedFiles list", () => {
			mockFileContent("x")
			manager.captureReadHash("src/a.ts")
			mockFileContent("y")
			manager.captureReadHash("src/b.ts")
			expect(manager.trackedFiles).toContain("src/a.ts")
			expect(manager.trackedFiles).toContain("src/b.ts")
		})
	})

	describe("validateWrite", () => {
		it("allows write when file is unchanged", () => {
			const content = "function foo() { return 1; }"
			mockFileContent(content)
			manager.captureReadHash("src/utils.ts")

			// Re-read same content at write time
			mockFileExistsThenReturns(content)
			const result = manager.validateWrite("src/utils.ts")

			expect(result.allowed).toBe(true)
			expect(result.conflict).toBe(false)
			expect(result.baselineHash).toBe(result.currentHash)
		})

		it("blocks write when file was modified externally", () => {
			mockFileContent("original content")
			manager.captureReadHash("src/config.ts")

			// File changed on disk
			mockFileExistsThenReturns("MODIFIED by another agent")
			const result = manager.validateWrite("src/config.ts")

			expect(result.allowed).toBe(false)
			expect(result.conflict).toBe(true)
			expect(result.reason).toContain("STALE FILE")
		})

		it("blocks write when file was deleted externally", () => {
			mockFileContent("exists at read time")
			manager.captureReadHash("src/deleted.ts")

			// File deleted
			mockFileDeleted()
			const result = manager.validateWrite("src/deleted.ts")

			expect(result.allowed).toBe(false)
			expect(result.conflict).toBe(true)
			expect(result.reason).toContain("deleted")
		})

		it("allows first-write when no baseline was captured", () => {
			const result = manager.validateWrite("src/new-file.ts")

			expect(result.allowed).toBe(true)
			expect(result.conflict).toBe(false)
			expect(result.baselineHash).toBeNull()
		})

		it("matches snapshot by agentId when specified", () => {
			// Agent A reads the file
			mockFileContent("version-A")
			manager.captureReadHash("shared.ts", "agent-A")

			// Agent B reads a different version
			mockFileContent("version-B")
			manager.captureReadHash("shared.ts", "agent-B")

			// At write time, disk has version-B (agent-B's baseline)
			mockFileExistsThenReturns("version-B")
			const resultB = manager.validateWrite("shared.ts", "agent-B")
			expect(resultB.allowed).toBe(true)

			// Agent A's baseline was version-A but disk is version-B → conflict
			mockFileExistsThenReturns("version-B")
			const resultA = manager.validateWrite("shared.ts", "agent-A")
			expect(resultA.allowed).toBe(false)
			expect(resultA.conflict).toBe(true)
		})

		it("increments conflictCount on each conflict", () => {
			expect(manager.conflictCount).toBe(0)

			mockFileContent("v1")
			manager.captureReadHash("a.ts")
			mockFileExistsThenReturns("v2")
			manager.validateWrite("a.ts")

			expect(manager.conflictCount).toBe(1)

			mockFileContent("v3")
			manager.captureReadHash("b.ts")
			mockFileExistsThenReturns("v4")
			manager.validateWrite("b.ts")

			expect(manager.conflictCount).toBe(2)
		})
	})

	describe("updateAfterWrite", () => {
		it("replaces the baseline hash after a successful write", () => {
			mockFileContent("old content")
			manager.captureReadHash("file.ts")

			// Write succeeds, new content on disk
			mockFileContent("new content after write")
			const newSnap = manager.updateAfterWrite("file.ts")

			expect(newSnap).not.toBeNull()
			expect(newSnap!.relativePath).toBe("file.ts")

			// Now validate should pass with new content
			mockFileExistsThenReturns("new content after write")
			const result = manager.validateWrite("file.ts")
			expect(result.allowed).toBe(true)
		})

		it("returns null if file was deleted after write", () => {
			mockFileContent("some content")
			manager.captureReadHash("temp.ts")

			mockFileDeleted()
			const result = manager.updateAfterWrite("temp.ts")
			expect(result).toBeNull()
		})
	})

	describe("clearFile", () => {
		it("removes tracking for a specific file", () => {
			mockFileContent("x")
			manager.captureReadHash("a.ts")
			mockFileContent("y")
			manager.captureReadHash("b.ts")

			manager.clearFile("a.ts")
			expect(manager.trackedFiles).not.toContain("a.ts")
			expect(manager.trackedFiles).toContain("b.ts")
		})
	})

	describe("clearAll", () => {
		it("removes all tracking state and resets conflict count", () => {
			mockFileContent("v1")
			manager.captureReadHash("a.ts")
			mockFileExistsThenReturns("v2")
			manager.validateWrite("a.ts") // creates a conflict

			expect(manager.conflictCount).toBe(1)
			expect(manager.trackedFiles.length).toBeGreaterThan(0)

			manager.clearAll()

			expect(manager.conflictCount).toBe(0)
			expect(manager.trackedFiles).toEqual([])
		})
	})

	describe("getSnapshot", () => {
		it("returns the latest snapshot for a tracked file", () => {
			mockFileContent("content-1")
			manager.captureReadHash("src/file.ts")

			const snap = manager.getSnapshot("src/file.ts")
			expect(snap).not.toBeNull()
			expect(snap!.hash).toMatch(/^sha256:/)
		})

		it("returns null for an untracked file", () => {
			expect(manager.getSnapshot("not-tracked.ts")).toBeNull()
		})
	})

	describe("normalizePath", () => {
		it("converts backslashes to forward slashes", () => {
			expect(OptimisticLockManager.normalizePath(String.raw`src\hooks\file.ts`)).toBe("src/hooks/file.ts")
		})

		it("strips leading ./", () => {
			expect(OptimisticLockManager.normalizePath("./src/file.ts")).toBe("src/file.ts")
		})

		it("leaves clean paths unchanged", () => {
			expect(OptimisticLockManager.normalizePath("src/file.ts")).toBe("src/file.ts")
		})
	})

	describe("formatStaleFileError", () => {
		it("produces structured XML error feedback", () => {
			const result: LockValidationResult = {
				allowed: false,
				reason: "STALE FILE: file changed",
				baselineHash: "sha256:aaa",
				currentHash: "sha256:bbb",
				conflict: true,
			}

			const error = OptimisticLockManager.formatStaleFileError(
				"write_to_file",
				"src/utils.ts",
				result,
				"intent-123",
			)

			expect(error).toContain("<concurrency_error>")
			expect(error).toContain("STALE_FILE")
			expect(error).toContain("write_to_file")
			expect(error).toContain("src/utils.ts")
			expect(error).toContain("sha256:aaa")
			expect(error).toContain("sha256:bbb")
			expect(error).toContain("intent-123")
			expect(error).toContain("re-read")
			expect(error).toContain("</concurrency_error>")
		})

		it("handles null intent and deleted file", () => {
			const result: LockValidationResult = {
				allowed: false,
				reason: "File deleted",
				baselineHash: "sha256:xxx",
				currentHash: null,
				conflict: true,
			}

			const error = OptimisticLockManager.formatStaleFileError("edit", "gone.ts", result, null)

			expect(error).toContain("none") // intent
			expect(error).toContain("deleted") // currentHash
		})
	})

	describe("ring buffer", () => {
		it("keeps at most MAX_SNAPSHOTS_PER_FILE entries per file", () => {
			// Capture 15 hashes for the same file (MAX is 10)
			for (let i = 0; i < 15; i++) {
				mockFileContent(`content-${i}`)
				manager.captureReadHash("busy-file.ts")
			}

			// File is still tracked as one entry in trackedFiles
			expect(manager.trackedFiles).toEqual(["busy-file.ts"])

			// We can't directly inspect registry size, but getSnapshot returns latest
			const snap = manager.getSnapshot("busy-file.ts")
			expect(snap).not.toBeNull()
		})
	})
})
