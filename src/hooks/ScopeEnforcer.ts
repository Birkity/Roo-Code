/** Enforces that file-write operations only target files within an intent's owned_scope. */

import * as path from "node:path"

export interface ScopeCheckResult {
	/** Whether the file is within the owned scope */
	allowed: boolean

	/** The file path that was checked (normalized) */
	checkedPath: string

	/** The owned scope patterns that were evaluated */
	ownedScope: string[]

	/** The specific pattern that matched (if allowed) */
	matchedPattern?: string

	/** Human-readable reason */
	reason: string
}

/** Regex-special characters mapped to their escaped forms. */
const REGEX_ESCAPE_MAP: ReadonlyMap<string, string> = new Map([
	[".", String.raw`\.`],
	["+", String.raw`\+`],
	["^", String.raw`\^`],
	["$", String.raw`\$`],
	["{", String.raw`\{`],
	["}", String.raw`\}`],
	["(", String.raw`\(`],
	[")", String.raw`\)`],
	["|", String.raw`\|`],
	["[", String.raw`\[`],
	["]", String.raw`\]`],
])

function globToRegex(pattern: string): RegExp {
	// Normalize path separators to forward slashes
	let normalized = pattern.replaceAll("\\", "/")

	// Replace glob wildcards with placeholders BEFORE escaping
	normalized = normalized.replaceAll("**", "§GLOBSTAR§")
	normalized = normalized.replaceAll("*", "§WILDCARD§")

	// Escape regex special characters
	for (const [char, escaped] of REGEX_ESCAPE_MAP) {
		normalized = normalized.replaceAll(char, escaped)
	}

	// Replace placeholders with regex equivalents
	normalized = normalized.replaceAll("§GLOBSTAR§", ".*")
	normalized = normalized.replaceAll("§WILDCARD§", "[^/]*")

	return new RegExp(`^${normalized}$`)
}

function matchesGlob(filePath: string, pattern: string): boolean {
	const normalizedPath = filePath.replaceAll("\\", "/")
	const regex = globToRegex(pattern)
	return regex.test(normalizedPath)
}

export class ScopeEnforcer {
	static check(targetPath: string, ownedScope: string[], cwd: string): ScopeCheckResult {
		if (!ownedScope || ownedScope.length === 0) {
			return {
				allowed: true,
				checkedPath: targetPath,
				ownedScope,
				reason: "No owned_scope defined — all writes allowed.",
			}
		}

		let relativePath = targetPath

		if (path.isAbsolute(targetPath)) {
			relativePath = path.relative(cwd, targetPath)
		}

		relativePath = relativePath.replaceAll("\\", "/")
		relativePath = relativePath.replace(/^\.\//, "").replace(/^\//, "")

		for (const pattern of ownedScope) {
			if (matchesGlob(relativePath, pattern)) {
				return {
					allowed: true,
					checkedPath: relativePath,
					ownedScope,
					matchedPattern: pattern,
					reason: `File "${relativePath}" matches scope pattern "${pattern}".`,
				}
			}
		}

		return {
			allowed: false,
			checkedPath: relativePath,
			ownedScope,
			reason:
				`Scope Violation: File "${relativePath}" is not authorized under intent's owned_scope. ` +
				`Allowed patterns: [${ownedScope.join(", ")}].`,
		}
	}

	/** Extracts the target file path from tool parameters, checking common param names. */
	static extractTargetPath(toolName: string, params: Record<string, unknown>): string | null {
		const pathKeys = ["path", "file_path", "filePath", "target_file", "file"]

		for (const key of pathKeys) {
			if (params[key] && typeof params[key] === "string") {
				return params[key]
			}
		}

		if (params.diff && typeof params.diff === "string") {
			const diffMatch = /^---\s+(?:a\/)?(.+)$/m.exec(params.diff)
			if (diffMatch) {
				return diffMatch[1]
			}
		}

		return null
	}
}
