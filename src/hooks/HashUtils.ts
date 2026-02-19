/**
 * HashUtils.ts — Phase 3: Spatial Hashing for Content-Addressable Traceability
 *
 * Implements SHA-256 content hashing to achieve **spatial independence** in the
 * Agent Trace system. By computing a cryptographic digest of each modified code
 * block, the traceability engine can re-link moved or refactored code back to
 * its originating intent — regardless of line-number shifts.
 *
 * Why SHA-256?
 *   The TRP1 spec and Agent Trace specification allow Murmur3 or SHA-256.
 *   We choose SHA-256 because:
 *   - It is a cryptographic hash (collision-resistant, tamper-evident)
 *   - Node.js ships it natively in `node:crypto` — zero dependencies
 *   - The `sha256:` prefix in the Agent Trace schema is explicit
 *
 * Normalization:
 *   Before hashing, the source text is optionally normalized to ensure that
 *   trivial whitespace or line-ending differences do not break hash continuity
 *   across platforms (Windows CRLF vs. Unix LF).
 *
 * Architecture:
 *   write_to_file execution
 *         ↓
 *   TraceLogger post-hook
 *         ↓
 *   HashUtils.hashContent(content)  →  "sha256:a8f5f167..."
 *         ↓
 *   Embedded in ranges[].content_hash of agent_trace.jsonl
 *
 * @see TraceLogger.ts   — consumes hashes for trace records
 * @see agent-trace.dev  — Agent Trace specification
 * @see TRP1 Challenge Week 1, Phase 3 — Spatial Hashing
 * @see Research Paper, Phase 3 — Spatial Hashing Implementation
 */

import { createHash } from "node:crypto"

// ── Public Interface ─────────────────────────────────────────────────────

/**
 * Options for content hashing.
 */
export interface HashOptions {
	/**
	 * Whether to normalize whitespace before hashing.
	 * When true:
	 *   - Converts CRLF → LF
	 *   - Trims trailing whitespace per line
	 *   - Removes trailing newlines
	 *
	 * This ensures identical code produces the same hash regardless
	 * of the editor's line-ending settings.
	 *
	 * @default true
	 */
	normalize?: boolean

	/**
	 * Hash algorithm to use.
	 * @default "sha256"
	 */
	algorithm?: "sha256" | "md5"
}

/**
 * Result of a content hash operation.
 */
export interface HashResult {
	/** The hash digest, prefixed with algorithm (e.g., "sha256:a8f5f167...") */
	hash: string

	/** The raw hex digest without prefix */
	hexDigest: string

	/** The algorithm used */
	algorithm: string

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
		const { normalize = true, algorithm = "sha256" } = options

		// Normalize content if requested
		const processed = normalize ? HashUtils.normalizeContent(content) : content

		// Compute hash
		const hexDigest = createHash(algorithm).update(processed, "utf8").digest("hex")

		return {
			hash: `${algorithm}:${hexDigest}`,
			hexDigest,
			algorithm,
			inputLength: processed.length,
		}
	}

	/**
	 * Compute the SHA-256 hash of an entire file's content.
	 *
	 * Used for optimistic locking in Phase 4 — computing a file-level
	 * hash to detect concurrent modifications by parallel agents.
	 *
	 * @param content - Full file content as string
	 * @returns Prefixed hash string (e.g., "sha256:...")
	 */
	static hashFile(content: string): string {
		return HashUtils.hashContent(content, { normalize: false }).hash
	}

	/**
	 * Compute hashes for a specific line range within file content.
	 *
	 * Extracts lines [startLine, endLine] (1-indexed, inclusive) and
	 * hashes just that block. This creates spatially independent
	 * attribution that survives line shifts.
	 *
	 * @param fileContent - The full file content
	 * @param startLine   - 1-indexed start line
	 * @param endLine     - 1-indexed end line (inclusive)
	 * @returns HashResult for the extracted range, or null if range is invalid
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
	 * Verify that a content hash matches the given content.
	 *
	 * Used for integrity verification — checking that code hasn't been
	 * tampered with since the trace was recorded.
	 *
	 * @param content      - The content to verify
	 * @param expectedHash - The expected hash (prefixed, e.g., "sha256:abc...")
	 * @returns true if the content matches the expected hash
	 */
	static verify(content: string, expectedHash: string): boolean {
		// Parse the algorithm prefix
		const colonIndex = expectedHash.indexOf(":")
		if (colonIndex === -1) {
			return false
		}

		const algorithm = expectedHash.substring(0, colonIndex) as "sha256" | "md5"
		const actual = HashUtils.hashContent(content, { algorithm })

		return actual.hash === expectedHash
	}

	// ── Normalization ────────────────────────────────────────────────

	/**
	 * Normalize content for consistent hashing across platforms.
	 *
	 * Transformations:
	 *   1. Convert Windows CRLF (\\r\\n) to Unix LF (\\n)
	 *   2. Trim trailing whitespace from each line
	 *   3. Remove trailing newlines from the end
	 *
	 * This ensures that the same code produces the same hash regardless
	 * of whether it was edited on Windows, macOS, or Linux.
	 *
	 * @param content - Raw content string
	 * @returns Normalized content
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
