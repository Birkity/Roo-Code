/** AST-aware patching enforcement — blocks full-file rewrites in favor of targeted diffs. */

/** Result of a patch validation check. */
export interface PatchValidationResult {
	/** Whether the patch/write is acceptable */
	valid: boolean

	/** Whether this is a full-file rewrite (should use diff instead) */
	isFullRewrite: boolean

	/** The type of patch detected */
	patchType: PatchType

	/** Human-readable reason for the decision */
	reason: string

	/** Suggested action for the agent */
	guidance: string | null

	/** Estimated change ratio (0-1, higher = more changed) */
	changeRatio: number
}

/** Types of patches/writes the system can detect. */
export enum PatchType {
	/** A targeted diff affecting specific lines/functions */
	TARGETED_DIFF = "TARGETED_DIFF",
	/** A new file creation (no prior content) */
	NEW_FILE = "NEW_FILE",
	/** A full-file rewrite (should be a diff) */
	FULL_REWRITE = "FULL_REWRITE",
	/** A small, focused modification via write_to_file */
	MINOR_EDIT = "MINOR_EDIT",
	/** A search-and-replace operation (inherently targeted) */
	SEARCH_REPLACE = "SEARCH_REPLACE",
}

/** AST-level patch target info (for structural anchoring). */
export interface PatchTarget {
	/** Type of AST node targeted */
	nodeType: "function" | "class" | "interface" | "export" | "import" | "block" | "unknown"

	/** Name of the targeted symbol (e.g., "authenticateUser") */
	symbolName: string | null

	/** Approximate start line of the target */
	startLine: number

	/** Approximate end line of the target */
	endLine: number
}

/** A parsed unified diff hunk. */
export interface DiffHunk {
	/** Old file start line */
	oldStart: number
	/** Number of lines removed */
	oldCount: number
	/** New file start line */
	newStart: number
	/** Number of lines added */
	newCount: number
	/** The raw hunk content (lines) */
	content: string[]
}

/** Above this change ratio, a write is considered a full rewrite. */
const FULL_REWRITE_THRESHOLD = 0.6

/** Files below this line count skip rewrite detection. */
const MIN_LINES_FOR_REWRITE_CHECK = 15

const PATCH_VALIDATED_TOOLS: ReadonlySet<string> = new Set([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
])

const FUNCTION_DECLARATION_PATTERN = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/

const FUNCTION_ASSIGNMENT_PATTERN = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function)/

const CLASS_PATTERN = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/

const INTERFACE_PATTERN = /(?:export\s+)?(?:interface|type)\s+(\w+)/

/** Validates and enforces AST-aware patching policies. */
export class AstPatchValidator {
	static validate(
		toolName: string,
		oldContent: string,
		newContent: string,
		params: Record<string, unknown> = {},
	): PatchValidationResult {
		if (!PATCH_VALIDATED_TOOLS.has(toolName)) {
			return AstPatchValidator.allowResult("Non-validated tool", PatchType.MINOR_EDIT, 0)
		}

		if (oldContent.trim() === "") {
			return AstPatchValidator.allowResult("New file creation", PatchType.NEW_FILE, 1)
		}

		if (toolName === "search_and_replace" || toolName === "search_replace") {
			return AstPatchValidator.allowResult(
				"Search-and-replace is inherently targeted",
				PatchType.SEARCH_REPLACE,
				AstPatchValidator.computeChangeRatio(oldContent, newContent),
			)
		}

		if (toolName === "apply_diff" || toolName === "apply_patch") {
			return AstPatchValidator.validateDiff(params)
		}

		return AstPatchValidator.validateFullWrite(oldContent, newContent)
	}

	private static validateFullWrite(oldContent: string, newContent: string): PatchValidationResult {
		const oldLines = oldContent.split("\n")
		const newLines = newContent.split("\n")

		if (oldLines.length < MIN_LINES_FOR_REWRITE_CHECK) {
			const changeRatio = AstPatchValidator.computeChangeRatio(oldContent, newContent)
			return AstPatchValidator.allowResult(
				`Small file (${oldLines.length} lines) — full write acceptable`,
				PatchType.MINOR_EDIT,
				changeRatio,
			)
		}

		const changeRatio = AstPatchValidator.computeChangeRatio(oldContent, newContent)

		if (changeRatio >= FULL_REWRITE_THRESHOLD) {
			const changedFunctions = AstPatchValidator.identifyChangedSymbols(oldContent, newContent)
			const guidance = AstPatchValidator.buildDiffGuidance(changedFunctions, oldContent, newContent)

			return {
				valid: false,
				isFullRewrite: true,
				patchType: PatchType.FULL_REWRITE,
				reason:
					`Full-file rewrite detected: ${(changeRatio * 100).toFixed(0)}% of the file changed ` +
					`(${newLines.length} new lines vs ${oldLines.length} old lines). ` +
					`This risks overwriting unrelated modifications by other agents or humans.`,
				guidance,
				changeRatio,
			}
		}

		return AstPatchValidator.allowResult(
			`Acceptable change ratio: ${(changeRatio * 100).toFixed(0)}%`,
			PatchType.MINOR_EDIT,
			changeRatio,
		)
	}

	private static validateDiff(params: Record<string, unknown>): PatchValidationResult {
		let diffContent: string | null = null
		if (typeof params.diff === "string") {
			diffContent = params.diff
		} else if (typeof params.content === "string") {
			diffContent = params.content
		}

		if (!diffContent) {
			return AstPatchValidator.allowResult(
				"No diff content to validate — allowing tool to handle errors",
				PatchType.TARGETED_DIFF,
				0,
			)
		}

		const hunks = AstPatchValidator.parseUnifiedDiff(diffContent)

		if (hunks.length === 0) {
			return AstPatchValidator.allowResult(
				"No parseable hunks (tool-specific format)",
				PatchType.TARGETED_DIFF,
				0,
			)
		}

		const totalHunkLines = hunks.reduce((sum, h) => sum + h.newCount, 0)
		const changeEstimate = totalHunkLines > 0 ? Math.min(totalHunkLines / 100, 1) : 0

		return AstPatchValidator.allowResult(
			`Targeted diff with ${hunks.length} hunk(s), ${totalHunkLines} lines changed`,
			PatchType.TARGETED_DIFF,
			changeEstimate,
		)
	}

	/** Identify functions/classes that changed between old and new content. */
	static identifyChangedSymbols(oldContent: string, newContent: string): PatchTarget[] {
		const oldSymbols = AstPatchValidator.extractSymbols(oldContent)
		const newSymbols = AstPatchValidator.extractSymbols(newContent)
		const changed: PatchTarget[] = []

		for (const newSym of newSymbols) {
			const oldSym = oldSymbols.find((s) => s.symbolName === newSym.symbolName && s.nodeType === newSym.nodeType)
			if (!oldSym) {
				changed.push(newSym)
			}
		}

		for (const oldSym of oldSymbols) {
			const exists = newSymbols.find((s) => s.symbolName === oldSym.symbolName && s.nodeType === oldSym.nodeType)
			if (!exists) {
				changed.push(oldSym)
			}
		}

		return changed
	}

	/** Extract symbols (functions, classes, interfaces) via regex-based detection. */
	static extractSymbols(content: string): PatchTarget[] {
		const symbols: PatchTarget[] = []
		const lines = content.split("\n")

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]

			const funcDeclMatch = FUNCTION_DECLARATION_PATTERN.exec(line)
			const funcAssignMatch = funcDeclMatch ? null : FUNCTION_ASSIGNMENT_PATTERN.exec(line)
			const funcMatch = funcDeclMatch ?? funcAssignMatch
			if (funcMatch) {
				const name = funcMatch[1]
				const endLine = AstPatchValidator.findBlockEnd(lines, i)
				symbols.push({
					nodeType: "function",
					symbolName: name ?? null,
					startLine: i + 1,
					endLine: endLine + 1,
				})
				continue
			}

			const classMatch = CLASS_PATTERN.exec(line)
			if (classMatch) {
				const endLine = AstPatchValidator.findBlockEnd(lines, i)
				symbols.push({
					nodeType: "class",
					symbolName: classMatch[1],
					startLine: i + 1,
					endLine: endLine + 1,
				})
				continue
			}

			const ifaceMatch = INTERFACE_PATTERN.exec(line)
			if (ifaceMatch) {
				const endLine = AstPatchValidator.findBlockEnd(lines, i)
				symbols.push({
					nodeType: "interface",
					symbolName: ifaceMatch[1],
					startLine: i + 1,
					endLine: endLine + 1,
				})
			}
		}

		return symbols
	}

	/** Parse a unified diff string into structured hunks. */
	static parseUnifiedDiff(diffText: string): DiffHunk[] {
		const hunks: DiffHunk[] = []
		const hunkHeaderPattern = /^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/

		const lines = diffText.split("\n")
		let currentHunk: DiffHunk | null = null

		for (const line of lines) {
			const match = hunkHeaderPattern.exec(line)
			if (match) {
				if (currentHunk) {
					hunks.push(currentHunk)
				}
				currentHunk = {
					oldStart: Number.parseInt(match[1], 10),
					oldCount: Number.parseInt(match[2] ?? "1", 10),
					newStart: Number.parseInt(match[3], 10),
					newCount: Number.parseInt(match[4] ?? "1", 10),
					content: [],
				}
			} else if (currentHunk) {
				currentHunk.content.push(line)
			}
		}

		if (currentHunk) {
			hunks.push(currentHunk)
		}

		return hunks
	}

	/** Compute the ratio of changed lines (0 = identical, 1 = completely different). */
	static computeChangeRatio(oldContent: string, newContent: string): number {
		const oldLines = oldContent.split("\n")
		const newLines = newContent.split("\n")
		const maxLines = Math.max(oldLines.length, newLines.length)

		if (maxLines === 0) {
			return 0
		}

		let diffCount = 0
		const oldSet = new Set(oldLines.map((l) => l.trim()))

		for (const line of newLines) {
			if (!oldSet.has(line.trim())) {
				diffCount++
			}
		}

		const newSet = new Set(newLines.map((l) => l.trim()))
		for (const line of oldLines) {
			if (!newSet.has(line.trim())) {
				diffCount++
			}
		}

		return Math.min(diffCount / (maxLines * 2), 1)
	}

	private static buildDiffGuidance(changedSymbols: PatchTarget[], oldContent: string, newContent: string): string {
		const lines = [
			"<patch_guidance>",
			"  Instead of rewriting the entire file, use apply_diff to make targeted edits:",
		]

		if (changedSymbols.length > 0) {
			lines.push("  Changed symbols detected:")
			for (const sym of changedSymbols.slice(0, 5)) {
				lines.push(`    - ${sym.nodeType} "${sym.symbolName}" (lines ${sym.startLine}-${sym.endLine})`)
			}
		}

		lines.push(
			"  ",
			"  Use one of these approaches:",
			"  1. apply_diff — provide a unified diff targeting only the changed functions",
			"  2. search_and_replace — replace specific strings/patterns",
			"  3. edit — multi-edit approach targeting specific line ranges",
			"  ",
			"  This prevents overwriting concurrent modifications by other agents.",
			"</patch_guidance>",
		)

		return lines.join("\n")
	}

	private static allowResult(reason: string, patchType: PatchType, changeRatio: number): PatchValidationResult {
		return {
			valid: true,
			isFullRewrite: false,
			patchType,
			reason,
			guidance: null,
			changeRatio,
		}
	}

	/** Find the end of a code block via balanced brace matching. */
	private static findBlockEnd(lines: string[], startLine: number): number {
		let braceCount = 0
		let foundOpen = false

		for (let i = startLine; i < lines.length; i++) {
			for (const char of lines[i]) {
				if (char === "{") {
					braceCount++
					foundOpen = true
				} else if (char === "}") {
					braceCount--
					if (foundOpen && braceCount === 0) {
						return i
					}
				}
			}
		}

		return startLine
	}

	/** Patch MCP tool definitions to include AST-aware patch enforcement warnings. */
	static patchMcpToolDefinitions(
		tools: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>,
	): Array<{ name: string; description: string; parameters?: Record<string, unknown> }> {
		const writeToolNames = new Set(["write_to_file", "insert_content", "create_file"])

		const patchWarning =
			"\n\n⚠️ AST-AWARE PATCH ENFORCEMENT: " +
			"Full-file rewrites on files with >15 lines are BLOCKED. " +
			"Use apply_diff or search_and_replace for targeted edits instead. " +
			"Only new files or files ≤15 lines may use write_to_file."

		return tools.map((tool) => {
			if (writeToolNames.has(tool.name)) {
				return {
					...tool,
					description: tool.description + patchWarning,
				}
			}
			return tool
		})
	}

	/** Get tool definition overrides for AST-aware patch enforcement. */
	static getToolDefinitionOverrides(): Record<string, string> {
		return {
			write_to_file:
				"⚠️ AST-AWARE PATCH ENFORCEMENT: " +
				"Full-file rewrites on files with >15 lines are BLOCKED by the " +
				"AST-Aware Patch Validator. Use apply_diff or search_and_replace " +
				"for targeted edits. Only new files or files ≤15 lines may use write_to_file. " +
				"Required parameters: intent_id, mutation_class.",
			insert_content:
				"⚠️ This tool is validated by the AST-Aware Patch Validator. " +
				"Content must target specific locations, not rewrite entire file sections.",
		}
	}
}
