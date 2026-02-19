/** Shared type definitions for the Hook Engine system. */

/** Context object passed to every hook at invocation time. */
export interface HookContext {
	/** The canonical name of the tool being called (e.g., "write_to_file") */
	toolName: string

	/** The tool parameters as provided by the AI agent */
	params: Record<string, unknown>

	/** The workspace root path (cwd) where .orchestration/ lives */
	cwd: string

	/** The currently active intent ID (null if none declared) */
	activeIntentId: string | null
}

/** Result from a pre-hook execution: allow, block, or inject. */
export type PreHookResult =
	| { action: "allow" }
	| { action: "block"; toolResult: string }
	| { action: "inject"; toolResult: string }

/** A single intent entry from .orchestration/active_intents.yaml. */
export interface IntentEntry {
	/** Unique identifier (e.g., "INT-001") */
	id: string

	/** Human-readable name (e.g., "JWT Authentication Migration") */
	name: string

	/** Current lifecycle status */
	status: string

	/** File globs that this intent is authorized to modify */
	owned_scope: string[]

	/** Architectural constraints the agent must respect */
	constraints: string[]

	/** Definition of Done — criteria for completion */
	acceptance_criteria: string[]
}

/** Root structure of .orchestration/active_intents.yaml. */
export interface ActiveIntentsFile {
	active_intents: IntentEntry[]
}

/** Tools that perform mutating operations, requiring an active intent. */
export const MUTATING_TOOLS: readonly string[] = [
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"execute_command",
	"generate_image",
] as const

/** Tools exempt from the gatekeeper intent check. */
export const EXEMPT_TOOLS: readonly string[] = [
	"select_active_intent",
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
	"read_command_output",
	"ask_followup_question",
	"attempt_completion",
	"switch_mode",
	"new_task",
	"update_todo_list",
	"run_slash_command",
	"skill",
	"use_mcp_tool",
	"access_mcp_resource",
] as const
