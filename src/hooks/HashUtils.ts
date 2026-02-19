/** SHA-256 content hashing utilities for content-addressable traceability. */

import { createHash } from "node:crypto"

export interface HashOptions {
	/**
	 * Whether to normalize whitespace before hashing (CRLF→LF, trim trailing).
	 * @default true
	 */
	normalize?: boolean
}

export interface HashResult {
	/** The hash digest, prefixed with algorithm (e.g., "sha256:a8f5f167...") */
	hash: string

	/** The raw hex digest without prefix */
	hexDigest: string

	/** Number of bytes hashed (after normalization) */
	inputLength: number
}

export class HashUtils {
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

	static hashFile(content: string): string {
		return HashUtils.hashContent(content, { normalize: false }).hash
	}

	/** Hash a specific line range (1-indexed, inclusive). Returns null if range is invalid. */
	static hashRange(fileContent: string, startLine: number, endLine: number): HashResult | null {
		const lines = fileContent.split("\n")

		if (startLine < 1 || endLine < startLine || startLine > lines.length) {
			return null
		}

		const clampedEnd = Math.min(endLine, lines.length)
		const rangeContent = lines.slice(startLine - 1, clampedEnd).join("\n")

		return HashUtils.hashContent(rangeContent)
	}

	static verify(content: string, expectedHash: string): boolean {
		if (!expectedHash.includes(":")) {
			return false
		}
		return HashUtils.hashContent(content).hash === expectedHash
	}

	/** Normalize content: CRLF→LF, trim trailing whitespace per line, remove trailing newlines. */
	static normalizeContent(content: string): string {
		return content
			.replaceAll("\r\n", "\n")
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			.replace(/\n+$/, "")
	}
}
