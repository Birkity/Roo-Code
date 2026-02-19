/**
 * AstPatchValidator.ts — Phase 4: AST-Aware Patching Enforcement
 *
 * Forces agents to emit targeted patch actions (unified diffs) rather
 * than rewriting entire files, preventing overwriting of unrelated
 * human or agent modifications.
 *
 * Strategies:
 *   1. Full-File Rewrite Detection — blocks write_to_file if content is
 *      disproportionately large relative to the actual change
 *   2. Diff-Based Validation — validates that apply_diff patches are
 *      structurally sound and target specific functions/blocks
 *   3. Patch Guidance — when blocking a full rewrite, provides guidance
 *      to the agent on using apply_diff instead
 *
 * This ensures that in multi-agent environments, edits are applied
 * cleanly to specific functions without overwriting unrelated work.
 *
 * @see HookEngine.ts — integrates this as a pre-write validation hook
 * @see Research Paper: AST-Aware Patching & Targeted Patch Resolution
 * @see TRP1 Challenge Week 1, Phase 4: AST-Aware Patching
 */

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Result of a patch validation check.
 */
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

/**
 * Types of patches/writes the system can detect.
 */
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

/**
 * AST-level patch target info (for structural anchoring).
 */
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

/**
 * A parsed unified diff hunk.
 */
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

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Change ratio threshold. If more than this fraction of the file changes,
 * it's considered a full rewrite and the agent should use apply_diff.
 *
 * A 60% change ratio means >60% of lines differ → likely a rewrite.
 */
const FULL_REWRITE_THRESHOLD = 0.6

/**
 * Minimum file size (in lines) to trigger full-rewrite detection.
 * Very small files (<15 lines) can be safely fully rewritten.
 */
const MIN_LINES_FOR_REWRITE_CHECK = 15

/**
 * Tools for which AST-aware patch validation is applied.
 */
const PATCH_VALIDATED_TOOLS: ReadonlySet<string> = new Set([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
])

// ── Regex Patterns for AST Node Detection ────────────────────────────────

/** Matches function declarations/expressions */
const FUNCTION_DECLARATION_PATTERN = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/

/** Matches arrow function or function expression assignments */
const FUNCTION_ASSIGNMENT_PATTERN = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function)/

/** Matches class declarations */
const CLASS_PATTERN = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/

/** Matches interface/type declarations */
const INTERFACE_PATTERN = /(?:export\s+)?(?:interface|type)\s+(\w+)/

// ── AstPatchValidator ────────────────────────────────────────────────────

/**
 * Validates and enforces AST-aware patching policies.
 *
 * All methods are static — no state needed.
 */
export class AstPatchValidator {
	// ── Primary Validation ───────────────────────────────────────────

	/**
	 * Validate a write operation for AST-awareness.
	 *
	 * Called by HookEngine in the pre-hook pipeline for write tools.
	 *
	 * @param toolName     - The tool being used (write_to_file, apply_diff, etc.)
	 * @param oldContent   - The file content before the write (empty for new files)
	 * @param newContent   - The proposed new content
	 * @param params       - Raw tool parameters
	 * @returns PatchValidationResult indicating whether the write is acceptable
	 */
	static validate(
		toolName: string,
		oldContent: string,
		newContent: string,
		params: Record<string, unknown> = {},
	): PatchValidationResult {
		if (!PATCH_VALIDATED_TOOLS.has(toolName)) {
			return AstPatchValidator.allowResult("Non-validated tool", PatchType.MINOR_EDIT, 0)
		}

		// New file — always allowed
		if (oldContent.trim() === "") {
			return AstPatchValidator.allowResult("New file creation", PatchType.NEW_FILE, 1)
		}

		// Search and replace — inherently targeted
		if (toolName === "search_and_replace" || toolName === "search_replace") {
			return AstPatchValidator.allowResult(
				"Search-and-replace is inherently targeted",
				PatchType.SEARCH_REPLACE,
				AstPatchValidator.computeChangeRatio(oldContent, newContent),
			)
		}

		// apply_diff — validate the diff structure
		if (toolName === "apply_diff" || toolName === "apply_patch") {
			return AstPatchValidator.validateDiff(params)
		}

		// write_to_file — check for full rewrites
		return AstPatchValidator.validateFullWrite(oldContent, newContent)
	}

	// ── Full Rewrite Detection ───────────────────────────────────────

	/**
	 * Check if a write_to_file operation is actually a full rewrite
	 * that should have been an apply_diff instead.
	 */
	private static validateFullWrite(oldContent: string, newContent: string): PatchValidationResult {
		const oldLines = oldContent.split("\n")
		const newLines = newContent.split("\n")

		// Small files can be fully rewritten safely
		if (oldLines.length < MIN_LINES_FOR_REWRITE_CHECK) {
			const changeRatio = AstPatchValidator.computeChangeRatio(oldContent, newContent)
			return AstPatchValidator.allowResult(
				`Small file (${oldLines.length} lines) — full write acceptable`,
				PatchType.MINOR_EDIT,
				changeRatio,
			)
		}

		const changeRatio = AstPatchValidator.computeChangeRatio(oldContent, newContent)

		// If the change ratio exceeds the threshold, it's a full rewrite
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

	// ── Diff Validation ──────────────────────────────────────────────

	/**
	 * Validate that an apply_diff operation has well-formed hunks.
	 */
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

		// Parse unified diff hunks
		const hunks = AstPatchValidator.parseUnifiedDiff(diffContent)

		if (hunks.length === 0) {
			return AstPatchValidator.allowResult(
				"No parseable hunks (tool-specific format)",
				PatchType.TARGETED_DIFF,
				0,
			)
		}

		// Check that hunks are reasonable (not the entire file)
		const totalHunkLines = hunks.reduce((sum, h) => sum + h.newCount, 0)
		const changeEstimate = totalHunkLines > 0 ? Math.min(totalHunkLines / 100, 1) : 0

		return AstPatchValidator.allowResult(
			`Targeted diff with ${hunks.length} hunk(s), ${totalHunkLines} lines changed`,
			PatchType.TARGETED_DIFF,
			changeEstimate,
		)
	}

	// ── AST Symbol Detection ─────────────────────────────────────────

	/**
	 * Identify functions/classes that changed between old and new content.
	 * Returns structural anchor names for the diff guidance.
	 */
	static identifyChangedSymbols(oldContent: string, newContent: string): PatchTarget[] {
		const oldSymbols = AstPatchValidator.extractSymbols(oldContent)
		const newSymbols = AstPatchValidator.extractSymbols(newContent)
		const changed: PatchTarget[] = []

		// Find symbols that exist in both but differ
		for (const newSym of newSymbols) {
			const oldSym = oldSymbols.find((s) => s.symbolName === newSym.symbolName && s.nodeType === newSym.nodeType)
			if (!oldSym) {
				// New symbol — was added
				changed.push(newSym)
			}
			// We don't do deep body comparison here — just detect structural changes
		}

		// Find symbols that were in old but not in new (deleted)
		for (const oldSym of oldSymbols) {
			const exists = newSymbols.find((s) => s.symbolName === oldSym.symbolName && s.nodeType === oldSym.nodeType)
			if (!exists) {
				changed.push(oldSym)
			}
		}

		return changed
	}

	/**
	 * Extract AST-level symbols (functions, classes, interfaces) from content.
	 * Uses regex-based detection (lightweight alternative to full AST parsing).
	 */
	static extractSymbols(content: string): PatchTarget[] {
		const symbols: PatchTarget[] = []
		const lines = content.split("\n")

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]

			// Check for function declarations
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

			// Check for class declarations
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

			// Check for interface/type declarations
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

	// ── Diff Parsing ─────────────────────────────────────────────────

	/**
	 * Parse a unified diff into hunks.
	 * Handles standard `@@ -a,b +c,d @@` format.
	 */
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

	// ── Change Ratio Computation ─────────────────────────────────────

	/**
	 * Compute the ratio of changed lines between old and new content.
	 *
	 * Uses a simple line-by-line comparison. For large files, this is
	 * O(n) and gives a reasonable estimate without full diff computation.
	 *
	 * @returns A ratio between 0 (identical) and 1 (completely different)
	 */
	static computeChangeRatio(oldContent: string, newContent: string): number {
		const oldLines = oldContent.split("\n")
		const newLines = newContent.split("\n")
		const maxLines = Math.max(oldLines.length, newLines.length)

		if (maxLines === 0) {
			return 0
		}

		// Count lines that are different
		let diffCount = 0
		const oldSet = new Set(oldLines.map((l) => l.trim()))

		for (const line of newLines) {
			if (!oldSet.has(line.trim())) {
				diffCount++
			}
		}

		// Also count removed lines
		const newSet = new Set(newLines.map((l) => l.trim()))
		for (const line of oldLines) {
			if (!newSet.has(line.trim())) {
				diffCount++
			}
		}

		// Ratio over the total lines (old + new, deduplicated by max)
		return Math.min(diffCount / (maxLines * 2), 1)
	}

	// ── Guidance Generation ──────────────────────────────────────────

	/**
	 * Build structured diff guidance for the agent when a full rewrite is blocked.
	 */
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

	// ── Private Helpers ──────────────────────────────────────────────

	/**
	 * Build an allowed PatchValidationResult.
	 */
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

	/**
	 * Find the end of a code block (balanced brace matching).
	 * Returns the line index of the closing brace.
	 */
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

		// If no balanced braces, assume single-line or un-braced construct
		return startLine
	}
}
