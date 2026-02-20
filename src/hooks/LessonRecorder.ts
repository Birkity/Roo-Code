/** Records lessons learned to CLAUDE.md for cross-session knowledge persistence. */

import * as fs from "node:fs"
import * as path from "node:path"

/** Category of lesson learned. */
export enum LessonCategory {
	LINT_FAILURE = "LINT_FAILURE",
	TEST_FAILURE = "TEST_FAILURE",
	BUILD_FAILURE = "BUILD_FAILURE",
	SCOPE_VIOLATION = "SCOPE_VIOLATION",
	LOCK_CONFLICT = "LOCK_CONFLICT",
	ARCHITECTURAL_DECISION = "ARCHITECTURAL_DECISION",
	STYLE_RULE = "STYLE_RULE",
	AGENT_INSIGHT = "AGENT_INSIGHT",
}

export interface LessonEntry {
	/** ISO timestamp */
	timestamp: string

	/** Category of the lesson */
	category: LessonCategory

	/** The intent context (if any) */
	intentId: string | null

	/** Which tool or action triggered the lesson */
	trigger: string

	/** The file that was being modified (if applicable) */
	filePath: string | null

	/** What went wrong */
	problem: string

	/** What was learned / the corrective action */
	lesson: string

	/** The agent's resolved action */
	resolution: string | null

	/** Severity: info, warning, error */
	severity: "info" | "warning" | "error"
}

export interface LessonResult {
	success: boolean
	filePath: string
	entryCount: number
	error?: string
}

const DEFAULT_BRAIN_FILE = "CLAUDE.md"

const MAX_LESSONS = 200
const LESSONS_SECTION = "## Lessons Learned"

export class LessonRecorder {
	static record(entry: LessonEntry, cwd: string): LessonResult {
		const brainPath = path.join(cwd, DEFAULT_BRAIN_FILE)

		try {
			LessonRecorder.ensureBrainFile(brainPath)
			const formatted = LessonRecorder.formatLesson(entry)
			LessonRecorder.appendLesson(brainPath, formatted)

			const currentCount = LessonRecorder.countLessons(brainPath)
			if (currentCount > MAX_LESSONS) {
				LessonRecorder.pruneOldestLessons(brainPath, currentCount - MAX_LESSONS)
			}

			console.log(`[LessonRecorder] Recorded: [${entry.category}] ${entry.lesson.substring(0, 60)}...`)

			return {
				success: true,
				filePath: brainPath,
				entryCount: currentCount,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error(`[LessonRecorder] Failed to record lesson: ${errorMessage}`)
			return {
				success: false,
				filePath: brainPath,
				entryCount: 0,
				error: errorMessage,
			}
		}
	}

	static recordLintFailure(
		filePath: string,
		errors: Array<{ line: number; message: string }>,
		intentId: string | null,
		cwd: string,
	): LessonResult {
		const errorSummary = errors
			.slice(0, 5)
			.map((e) => `Line ${e.line}: ${e.message}`)
			.join("; ")

		return LessonRecorder.record(
			{
				timestamp: new Date().toISOString(),
				category: LessonCategory.LINT_FAILURE,
				intentId,
				trigger: "PostToolHook (ESLint)",
				filePath,
				problem: `ESLint reported ${errors.length} error(s): ${errorSummary}`,
				lesson: `When modifying ${path.basename(filePath)}, ensure compliance with project ESLint rules. Common issues: ${LessonRecorder.extractRuleNames(errors).join(", ") || "check .eslintrc"}`,
				resolution: "Errors fed back to agent for self-correction",
				severity: "error",
			},
			cwd,
		)
	}

	static recordTestFailure(testCommand: string, stderr: string, intentId: string | null, cwd: string): LessonResult {
		return LessonRecorder.record(
			{
				timestamp: new Date().toISOString(),
				category: LessonCategory.TEST_FAILURE,
				intentId,
				trigger: `PostToolHook (test: ${testCommand})`,
				filePath: null,
				problem: `Test command failed: ${testCommand}\nOutput: ${stderr.substring(0, 300)}`,
				lesson: `Test suite requires attention. Check test expectations match the current implementation.`,
				resolution: "Agent should analyze test output and fix either tests or implementation",
				severity: "error",
			},
			cwd,
		)
	}

	static recordScopeViolation(
		targetPath: string,
		ownedScope: string[],
		intentId: string | null,
		cwd: string,
	): LessonResult {
		return LessonRecorder.record(
			{
				timestamp: new Date().toISOString(),
				category: LessonCategory.SCOPE_VIOLATION,
				intentId,
				trigger: "ScopeEnforcer (PreToolHook)",
				filePath: targetPath,
				problem: `Attempted to modify ${targetPath} which is outside owned scope: [${ownedScope.join(", ")}]`,
				lesson: `Intent ${intentId ?? "unknown"} is restricted to: ${ownedScope.join(", ")}. Do not attempt to modify files outside this scope without requesting scope expansion.`,
				resolution: "Write blocked. Agent should request scope expansion or use correct intent.",
				severity: "warning",
			},
			cwd,
		)
	}

	static recordLockConflict(
		filePath: string,
		baselineHash: string | null,
		currentHash: string | null,
		intentId: string | null,
		cwd: string,
	): LessonResult {
		return LessonRecorder.record(
			{
				timestamp: new Date().toISOString(),
				category: LessonCategory.LOCK_CONFLICT,
				intentId,
				trigger: "OptimisticLockManager (PreToolHook)",
				filePath,
				problem: `Stale file conflict on ${filePath}. Baseline hash: ${baselineHash?.substring(0, 20) ?? "none"}, Current hash: ${currentHash?.substring(0, 20) ?? "deleted"}`,
				lesson: `File ${path.basename(filePath)} was modified by another agent/human during this session. Always re-read files before writing in a concurrent environment.`,
				resolution: "Write blocked. Agent must re-read the file to get latest content.",
				severity: "warning",
			},
			cwd,
		)
	}

	static recordArchitecturalDecision(
		decision: string,
		rationale: string,
		intentId: string | null,
		cwd: string,
	): LessonResult {
		return LessonRecorder.record(
			{
				timestamp: new Date().toISOString(),
				category: LessonCategory.ARCHITECTURAL_DECISION,
				intentId,
				trigger: "Agent (manual)",
				filePath: null,
				problem: "N/A",
				lesson: `Decision: ${decision}. Rationale: ${rationale}`,
				resolution: null,
				severity: "info",
			},
			cwd,
		)
	}

	static formatLesson(entry: LessonEntry): string {
		let severityEmoji = "ℹ️"
		if (entry.severity === "error") {
			severityEmoji = "❌"
		} else if (entry.severity === "warning") {
			severityEmoji = "⚠️"
		}

		const lines = [`### ${severityEmoji} ${entry.category} — ${entry.timestamp.substring(0, 19)}`, ""]

		if (entry.intentId) {
			lines.push(`- **Intent**: ${entry.intentId}`)
		}
		if (entry.filePath) {
			lines.push(`- **File**: \`${entry.filePath}\``)
		}
		lines.push(
			`- **Trigger**: ${entry.trigger}`,
			`- **Problem**: ${entry.problem}`,
			`- **Lesson**: ${entry.lesson}`,
		)
		if (entry.resolution) {
			lines.push(`- **Resolution**: ${entry.resolution}`)
		}
		lines.push("")

		return lines.join("\n")
	}

	private static ensureBrainFile(filePath: string): void {
		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, "utf-8")
			if (!content.includes(LESSONS_SECTION)) {
				fs.appendFileSync(
					filePath,
					`\n\n${LESSONS_SECTION}\n\n_Automatically recorded by the Hook Engine when verification steps fail._\n\n`,
					"utf-8",
				)
			}
			return
		}

		const initialContent = [
			"# CLAUDE.md — Shared Brain",
			"",
			"This file is the persistent knowledge base shared across all agent sessions.",
			"It contains project-specific rules, stylistic conventions, and lessons learned",
			"from verification failures. All agents MUST read this file at session start.",
			"",
			"## Project Rules",
			"",
			"- Follow existing code style and patterns",
			"- Always declare an active intent before mutating files",
			"- Respect owned_scope boundaries",
			"- Use apply_diff for targeted edits (avoid full-file rewrites)",
			"",
			LESSONS_SECTION,
			"",
			"_Automatically recorded by the Hook Engine when verification steps fail._",
			"",
		].join("\n")

		const dir = path.dirname(filePath)
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true })
		}

		fs.writeFileSync(filePath, initialContent, "utf-8")
	}

	private static appendLesson(filePath: string, formattedLesson: string): void {
		fs.appendFileSync(filePath, formattedLesson, "utf-8")
	}

	private static countLessons(filePath: string): number {
		const content = fs.readFileSync(filePath, "utf-8")
		const lessonsSection = content.split(LESSONS_SECTION)[1] ?? ""
		return (lessonsSection.match(/^### /gm) ?? []).length
	}

	/** Removes the oldest N lessons to keep the file bounded. */
	private static pruneOldestLessons(filePath: string, count: number): void {
		const content = fs.readFileSync(filePath, "utf-8")
		const parts = content.split(LESSONS_SECTION)

		if (parts.length < 2) {
			return
		}

		const beforeSection = parts[0] + LESSONS_SECTION
		const lessonsContent = parts[1]

		const lessonBlocks = lessonsContent.split(/(?=^### )/gm).filter((b) => b.trim().length > 0)
		const remaining = lessonBlocks.slice(count)

		fs.writeFileSync(filePath, beforeSection + "\n\n" + remaining.join(""), "utf-8")
	}

	private static extractRuleNames(errors: Array<{ line: number; message: string }>): string[] {
		const rules = new Set<string>()
		for (const err of errors) {
			const match = /\[([^\]]+)\]/.exec(err.message)
			if (match) {
				rules.add(match[1])
			}
		}
		return Array.from(rules)
	}
}
