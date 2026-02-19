/**
 * HashUtils.test.ts — Tests for Phase 3 Spatial Hashing
 *
 * Validates:
 * - SHA-256 hashing with "sha256:" prefix
 * - Content normalization (CRLF → LF, trim trailing whitespace)
 * - Range hashing for spatially independent attribution
 * - Hash verification
 * - Deterministic output (same input → same hash)
 * - Spatial independence (content hash survives line shifts)
 */

import { describe, it, expect } from "vitest"
import { HashUtils } from "../HashUtils"

describe("HashUtils", () => {
	describe("hashContent", () => {
		it("produces a sha256-prefixed hash", () => {
			const result = HashUtils.hashContent("hello world")
			expect(result.hash).toMatch(/^sha256:[a-f0-9]{64}$/)
			expect(result.algorithm).toBe("sha256")
		})

		it("returns the correct hex digest length (64 chars for SHA-256)", () => {
			const result = HashUtils.hashContent("test content")
			expect(result.hexDigest).toHaveLength(64)
		})

		it("produces deterministic output (same input → same hash)", () => {
			const hash1 = HashUtils.hashContent("function foo() { return 42; }")
			const hash2 = HashUtils.hashContent("function foo() { return 42; }")
			expect(hash1.hash).toBe(hash2.hash)
		})

		it("produces different hashes for different content", () => {
			const hash1 = HashUtils.hashContent("function foo() { return 42; }")
			const hash2 = HashUtils.hashContent("function bar() { return 99; }")
			expect(hash1.hash).not.toBe(hash2.hash)
		})

		it("normalizes CRLF to LF by default", () => {
			const crlfContent = "line1\r\nline2\r\nline3"
			const lfContent = "line1\nline2\nline3"
			const hashCrlf = HashUtils.hashContent(crlfContent)
			const hashLf = HashUtils.hashContent(lfContent)
			expect(hashCrlf.hash).toBe(hashLf.hash)
		})

		it("trims trailing whitespace per line when normalizing", () => {
			const withTrailing = "line1   \nline2  \nline3"
			const withoutTrailing = "line1\nline2\nline3"
			const hash1 = HashUtils.hashContent(withTrailing)
			const hash2 = HashUtils.hashContent(withoutTrailing)
			expect(hash1.hash).toBe(hash2.hash)
		})

		it("skips normalization when normalize=false", () => {
			const crlfContent = "line1\r\nline2"
			const lfContent = "line1\nline2"
			const hashCrlf = HashUtils.hashContent(crlfContent, { normalize: false })
			const hashLf = HashUtils.hashContent(lfContent, { normalize: false })
			expect(hashCrlf.hash).not.toBe(hashLf.hash)
		})

		it("reports correct input length after normalization", () => {
			const content = "hello\r\nworld  "
			const result = HashUtils.hashContent(content)
			// After normalization: "hello\nworld" = 11 chars
			expect(result.inputLength).toBe(11)
		})
	})

	describe("hashFile", () => {
		it("produces a sha256-prefixed hash without normalization", () => {
			const hash = HashUtils.hashFile("file content here")
			expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/)
		})
	})

	describe("hashRange", () => {
		it("hashes a specific line range from file content", () => {
			const fileContent = "line1\nline2\nline3\nline4\nline5"
			const result = HashUtils.hashRange(fileContent, 2, 4)
			expect(result).not.toBeNull()
			expect(result!.hash).toMatch(/^sha256:/)

			// Hash of "line2\nline3\nline4"
			const directHash = HashUtils.hashContent("line2\nline3\nline4")
			expect(result!.hash).toBe(directHash.hash)
		})

		it("returns null for invalid ranges", () => {
			const fileContent = "line1\nline2\nline3"
			expect(HashUtils.hashRange(fileContent, 0, 2)).toBeNull()
			expect(HashUtils.hashRange(fileContent, 5, 6)).toBeNull()
			expect(HashUtils.hashRange(fileContent, 3, 1)).toBeNull()
		})

		it("clamps endLine to file length", () => {
			const fileContent = "line1\nline2\nline3"
			const result = HashUtils.hashRange(fileContent, 2, 100)
			expect(result).not.toBeNull()
			// Should hash lines 2-3
			const directHash = HashUtils.hashContent("line2\nline3")
			expect(result!.hash).toBe(directHash.hash)
		})

		it("achieves spatial independence — moved code has same hash", () => {
			// Original file: function at lines 2-4
			const original = "imports\nfunction foo() {\n  return 42;\n}\n"
			const hashOriginal = HashUtils.hashRange(original, 2, 4)

			// After adding 3 lines of imports, function moves to lines 5-7
			const moved = "import a\nimport b\nimport c\nimports\nfunction foo() {\n  return 42;\n}\n"
			const hashMoved = HashUtils.hashRange(moved, 5, 7)

			// The content hash should be identical — spatial independence!
			expect(hashOriginal!.hash).toBe(hashMoved!.hash)
		})
	})

	describe("verify", () => {
		it("verifies matching content + hash", () => {
			const content = "function verify() { return true; }"
			const hash = HashUtils.hashContent(content).hash
			expect(HashUtils.verify(content, hash)).toBe(true)
		})

		it("rejects mismatched content", () => {
			const hash = HashUtils.hashContent("original content").hash
			expect(HashUtils.verify("modified content", hash)).toBe(false)
		})

		it("rejects invalid hash format", () => {
			expect(HashUtils.verify("content", "invalidhash")).toBe(false)
		})
	})

	describe("normalizeContent", () => {
		it("converts CRLF to LF", () => {
			expect(HashUtils.normalizeContent("a\r\nb")).toBe("a\nb")
		})

		it("trims trailing whitespace per line", () => {
			expect(HashUtils.normalizeContent("a   \nb  ")).toBe("a\nb")
		})

		it("removes trailing newlines", () => {
			expect(HashUtils.normalizeContent("a\nb\n\n\n")).toBe("a\nb")
		})
	})
})
