/** Classifies tool calls into risk tiers (SAFE, DESTRUCTIVE, CRITICAL, META). */

export enum RiskTier {
	SAFE = "SAFE",
	DESTRUCTIVE = "DESTRUCTIVE",
	CRITICAL = "CRITICAL",
	META = "META",
}

export interface ClassificationResult {
	tier: RiskTier
	reason: string
	/** The specific pattern that matched (for CRITICAL commands) */
	matchedPattern?: string
}

const CRITICAL_COMMAND_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /\brm\s+(-[a-z]*r[a-z]*f|--recursive|--force)\b/i, label: "Recursive/forced file deletion (rm -rf)" },
	{ pattern: /\brm\s+-[a-z]*f/i, label: "Forced file deletion (rm -f)" },
	{ pattern: /\brmdir\b/i, label: "Directory removal (rmdir)" },
	{ pattern: /\bdel\s+\/s/i, label: "Recursive deletion (Windows del /s)" },
	{ pattern: /\brd\s+\/s/i, label: "Recursive directory removal (Windows rd /s)" },

	{ pattern: /\bgit\s+push\s+.*--force\b/i, label: "Force push (git push --force)" },
	{ pattern: /\bgit\s+push\s+-f\b/i, label: "Force push (git push -f)" },
	{ pattern: /\bgit\s+reset\s+--hard\b/i, label: "Hard reset (git reset --hard)" },
	{ pattern: /\bgit\s+clean\s+-[a-z]*f/i, label: "Git clean (removes untracked files)" },
	{ pattern: /\bgit\s+checkout\s+--\s+\./i, label: "Discard all changes (git checkout -- .)" },

	{ pattern: /\bchmod\s+777\b/i, label: "World-writable permissions (chmod 777)" },
	{ pattern: /\bchown\s+-R\b/i, label: "Recursive ownership change (chown -R)" },
	{ pattern: /\bcurl\s+.*\|\s*(bash|sh)\b/i, label: "Pipe remote script to shell (curl | bash)" },
	{ pattern: /\bwget\s+.*\|\s*(bash|sh)\b/i, label: "Pipe remote script to shell (wget | bash)" },
	{ pattern: /\beval\s*\(/i, label: "Dynamic code execution (eval)" },

	{ pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, label: "Database DROP operation" },
	{ pattern: /\bTRUNCATE\s+TABLE\b/i, label: "Database TRUNCATE operation" },
	{ pattern: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, label: "DELETE without WHERE clause" },

	{ pattern: /\bnpm\s+publish\b/i, label: "Publish package (npm publish)" },
	{ pattern: /\bnpx?\s+.*--yes\b/i, label: "Auto-confirm npx execution" },

	{ pattern: /\b>\s*\/dev\/null\b/i, label: "Redirect to /dev/null" },
	{ pattern: /\bformat\s+[a-z]:\b/i, label: "Format drive (Windows)" },
	{ pattern: /\bmkfs\b/i, label: "Format filesystem (mkfs)" },
]

const SAFE_TOOLS: ReadonlySet<string> = new Set([
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
	"read_command_output",
])

const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"generate_image",
])

const META_TOOLS: ReadonlySet<string> = new Set([
	"ask_followup_question",
	"attempt_completion",
	"switch_mode",
	"new_task",
	"update_todo_list",
	"run_slash_command",
	"skill",
	"select_active_intent",
])

export class CommandClassifier {
	static classify(toolName: string, params: Record<string, unknown>): ClassificationResult {
		if (META_TOOLS.has(toolName)) {
			return {
				tier: RiskTier.META,
				reason: `Tool "${toolName}" is a conversation/meta operation.`,
			}
		}

		if (SAFE_TOOLS.has(toolName)) {
			return {
				tier: RiskTier.SAFE,
				reason: `Tool "${toolName}" is a read-only operation.`,
			}
		}

		if (toolName === "execute_command") {
			const command = (params.command as string) ?? ""
			return CommandClassifier.classifyCommand(command)
		}

		if (DESTRUCTIVE_TOOLS.has(toolName)) {
			return {
				tier: RiskTier.DESTRUCTIVE,
				reason: `Tool "${toolName}" modifies the filesystem.`,
			}
		}

		// MCP and unknown tools default to DESTRUCTIVE (least privilege)
		if (toolName.startsWith("mcp_") || toolName === "use_mcp_tool") {
			return {
				tier: RiskTier.DESTRUCTIVE,
				reason: `MCP tool "${toolName}" — classified as destructive by default.`,
			}
		}

		return {
			tier: RiskTier.DESTRUCTIVE,
			reason: `Unknown tool "${toolName}" — classified as destructive by default (fail-safe).`,
		}
	}

	private static classifyCommand(command: string): ClassificationResult {
		for (const { pattern, label } of CRITICAL_COMMAND_PATTERNS) {
			if (pattern.test(command)) {
				return {
					tier: RiskTier.CRITICAL,
					reason: `Terminal command matches critical pattern: ${label}`,
					matchedPattern: label,
				}
			}
		}

		return {
			tier: RiskTier.DESTRUCTIVE,
			reason: "Terminal command execution — no critical patterns detected.",
		}
	}

	static isFileWriteOperation(toolName: string): boolean {
		return DESTRUCTIVE_TOOLS.has(toolName)
	}
}
