/**
 * HashUtils.ts — Phase 3: Spatial Hashing for Content-Addressable Traceability
 *
 * SHA-256 content hashing for spatial independence in the Agent Trace system.
 * Content hashes allow re-linking moved/refactored code to its originating
 * intent regardless of line-number shifts.
 *
 * Uses native `node:crypto` (zero dependencies). Content is optionally
 * normalized (CRLF→LF, trim trailing whitespace) for cross-platform consistency.
 *
 * @see TraceLogger.ts — consumes hashes for trace records
 * @see agent-trace.dev — Agent Trace specification
 */

import { createHash } from "node:crypto"

/**
 * Options for content hashing.
 */
export interface HashOptions {
	/**
	 * Whether to normalize whitespace before hashing (CRLF→LF, trim trailing).
	 * @default true
	 */
	normalize?: boolean
}

/**
 * Result of a content hash operation.
 */
export interface HashResult {
	/** The hash digest, prefixed with algorithm (e.g., "sha256:a8f5f167...") */
	hash: string

	/** The raw hex digest without prefix */
	hexDigest: string

	/** Number of bytes hashed (after normalization) */
	inputLength: number
}

// ── HashUtils ────────────────────────────────────────────────────────────

/**
 * Utility class for computing content-addressable hashes.
 *
 * All methods are static — no instantiation needed.
 */
export class HashUtils {
	/**
	 * Compute the SHA-256 hash of a string content block.
	 *
	 * This is the primary method used by TraceLogger to generate the
	 * `content_hash` field in the Agent Trace schema's `ranges` object.
	 *
	 * @param content - The source code text to hash
	 * @param options - Optional hashing configuration
	 * @returns HashResult with prefixed hash string
	 *
	 * @example
	 * ```ts
	 * const result = HashUtils.hashContent("function foo() { return 42; }")
	 * // result.hash === "sha256:3b9c358..."
	 * ```
	 */
	static hashContent(content: string, options: HashOptions = {}): HashResult {
		const { normalize = true } = options
		const processed = normalize ? HashUtils.normalizeContent(content) : content
		const hexDigest = createHash("sha256").update(processed, "utf8").digest("hex")

		return {
			hash: `sha256:${hexDigest}`,
			hexDigest,
			inputLength: processed.length,
		}
	}

	/**
	 * Compute the SHA-256 hash of an entire file's content (no normalization).
	 */
	static hashFile(content: string): string {
		return HashUtils.hashContent(content, { normalize: false }).hash
	}

	/**
	 * Hash a specific line range within file content (1-indexed, inclusive).
	 * Returns null if range is invalid.
	 */
	static hashRange(fileContent: string, startLine: number, endLine: number): HashResult | null {
		const lines = fileContent.split("\n")

		// Validate range (1-indexed)
		if (startLine < 1 || endLine < startLine || startLine > lines.length) {
			return null
		}

		// Clamp endLine to file length
		const clampedEnd = Math.min(endLine, lines.length)

		// Extract the range (convert from 1-indexed to 0-indexed)
		const rangeContent = lines.slice(startLine - 1, clampedEnd).join("\n")

		return HashUtils.hashContent(rangeContent)
	}

	/**
	 * Verify that content matches an expected hash.
	 */
	static verify(content: string, expectedHash: string): boolean {
		if (!expectedHash.includes(":")) {
			return false
		}
		return HashUtils.hashContent(content).hash === expectedHash
	}

	/**
	 * Normalize content for consistent cross-platform hashing.
	 * CRLF→LF, trims trailing whitespace per line, removes trailing newlines.
	 */
	static normalizeContent(content: string): string {
		return (
			content
				// 1. Normalize line endings: CRLF → LF
				.replaceAll("\r\n", "\n")
				// 2. Trim trailing whitespace per line
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n")
				// 3. Remove trailing newlines
				.replace(/\n+$/, "")
		)
	}
}
