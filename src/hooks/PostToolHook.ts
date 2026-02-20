/** Post-tool hook: runs formatting and linting after file-modifying tools. */

import * as fs from "node:fs"
import * as path from "node:path"
import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

export interface PostHookResult {
	/** Whether the post-hook produced supplementary feedback */
	hasErrors: boolean

	/** Formatted feedback string to append to the tool_result context */
	feedback: string | null

	/** The file that was processed */
	filePath: string | null
}

const FILE_MODIFYING_TOOLS: ReadonlySet<string> = new Set([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
])

export class PostToolHook {
	static async execute(toolName: string, params: Record<string, unknown>, cwd: string): Promise<PostHookResult> {
		if (!FILE_MODIFYING_TOOLS.has(toolName)) {
			return { hasErrors: false, feedback: null, filePath: null }
		}

		const filePath = PostToolHook.extractFilePath(toolName, params)
		if (!filePath) {
			return { hasErrors: false, feedback: null, filePath: null }
		}

		const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)

		if (!fs.existsSync(absolutePath)) {
			return { hasErrors: false, feedback: null, filePath }
		}

		const ext = path.extname(absolutePath).toLowerCase()
		const isFormattable = [
			".ts",
			".tsx",
			".js",
			".jsx",
			".json",
			".css",
			".scss",
			".md",
			".html",
			".yaml",
			".yml",
		].includes(ext)

		if (!isFormattable) {
			return { hasErrors: false, feedback: null, filePath }
		}

		const feedbackParts: string[] = []
		let hasErrors = false

		const prettierResult = await PostToolHook.runPrettier(absolutePath, cwd)
		if (prettierResult.error) {
			hasErrors = true
			feedbackParts.push(`[Prettier Error] ${prettierResult.error}`)
		} else if (prettierResult.formatted) {
			feedbackParts.push(`[Prettier] File auto-formatted: ${filePath}`)
		}

		const isLintable = [".ts", ".tsx", ".js", ".jsx"].includes(ext)
		if (isLintable) {
			const lintResult = await PostToolHook.runLinter(absolutePath, cwd)
			if (lintResult.errors.length > 0) {
				hasErrors = true
				feedbackParts.push(
					`[ESLint Errors] ${lintResult.errors.length} issue(s) found in ${filePath}:\n` +
						lintResult.errors.map((e) => `  Line ${e.line}: ${e.message}`).join("\n"),
				)
			}
		}

		if (feedbackParts.length === 0) {
			return { hasErrors: false, feedback: null, filePath }
		}

		const feedback = `<post_edit_feedback>\n${feedbackParts.join("\n\n")}\n</post_edit_feedback>`

		return { hasErrors, feedback, filePath }
	}

	private static extractFilePath(toolName: string, params: Record<string, unknown>): string | null {
		const pathKeys = ["path", "file_path", "filePath", "target_file", "file"]

		for (const key of pathKeys) {
			if (params[key] && typeof params[key] === "string") {
				return params[key]
			}
		}

		return null
	}

	private static async runPrettier(
		filePath: string,
		cwd: string,
	): Promise<{ formatted: boolean; error: string | null }> {
		try {
			const prettierPath = PostToolHook.findBinary("prettier", cwd)
			if (!prettierPath) {
				return { formatted: false, error: null }
			}

			const contentBefore = fs.readFileSync(filePath, "utf-8")

			await execAsync(`"${prettierPath}" --write "${filePath}"`, {
				cwd,
				timeout: 10000, // 10s timeout
			})

			const contentAfter = fs.readFileSync(filePath, "utf-8")
			const formatted = contentBefore !== contentAfter

			return { formatted, error: null }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (message.includes("ENOENT") || message.includes("not found") || message.includes("not recognized")) {
				return { formatted: false, error: null }
			}
			return { formatted: false, error: message.substring(0, 500) }
		}
	}

	/** Extracts severity >= 2 (error-level) messages from ESLint JSON output. */
	private static parseEslintOutput(jsonString: string): Array<{ line: number; message: string }> {
		const results = JSON.parse(jsonString)
		const errors: Array<{ line: number; message: string }> = []

		if (!Array.isArray(results) || results.length === 0) {
			return errors
		}

		const fileResult = results[0]
		if (!fileResult.messages || !Array.isArray(fileResult.messages)) {
			return errors
		}

		for (const msg of fileResult.messages) {
			if (msg.severity >= 2) {
				errors.push({
					line: msg.line ?? 0,
					message: `[${msg.ruleId ?? "unknown"}] ${msg.message}`,
				})
			}
		}

		return errors
	}

	private static async runLinter(
		filePath: string,
		cwd: string,
	): Promise<{ errors: Array<{ line: number; message: string }> }> {
		try {
			const eslintPath = PostToolHook.findBinary("eslint", cwd)
			if (!eslintPath) {
				return { errors: [] }
			}

			const { stdout } = await execAsync(`"${eslintPath}" --format json --no-color "${filePath}"`, {
				cwd,
				timeout: 30000,
			})

			return { errors: PostToolHook.parseEslintOutput(stdout) }
		} catch (error) {
			const execError = error as { stdout?: string; message?: string }

			if (execError.stdout) {
				try {
					return { errors: PostToolHook.parseEslintOutput(execError.stdout) }
				} catch {
					// parse failed
				}
			}

			const message = execError.message ?? ""
			if (message.includes("ENOENT") || message.includes("not found") || message.includes("not recognized")) {
				return { errors: [] }
			}

			return {
				errors: [{ line: 0, message: `ESLint execution error: ${message.substring(0, 300)}` }],
			}
		}
	}

	private static findBinary(name: string, cwd: string): string | null {
		const isWindows = process.platform === "win32"
		const binExt = isWindows ? ".cmd" : ""
		const localBin = path.join(cwd, "node_modules", ".bin", `${name}${binExt}`)

		if (fs.existsSync(localBin)) {
			return localBin
		}

		return name
	}
}
