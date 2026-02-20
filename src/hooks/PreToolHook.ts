/** Pre-hook that blocks mutating tools unless an active intent has been declared. */

import type { HookContext, PreHookResult } from "./types"
import { EXEMPT_TOOLS } from "./types"
import type { HookEngine } from "./HookEngine"

export class GatekeeperHook {
	static async execute(ctx: HookContext, engine: HookEngine): Promise<PreHookResult> {
		if (GatekeeperHook.isExempt(ctx.toolName)) {
			return { action: "allow" }
		}

		if (engine.hasActiveIntent()) {
			return { action: "allow" }
		}

		console.warn(
			`[Gatekeeper] BLOCKED: Tool "${ctx.toolName}" requires an active intent. ` +
				`No intent has been declared via select_active_intent().`,
		)

		return {
			action: "block",
			toolResult:
				`[Gatekeeper Violation] You must cite a valid active Intent ID before any tool use.\n\n` +
				`The tool "${ctx.toolName}" is a mutating operation that requires an active business intent.\n` +
				`Before proceeding, you MUST:\n` +
				`  1. Analyze the user's request\n` +
				`  2. Identify the relevant intent from .orchestration/active_intents.yaml\n` +
				`  3. Call select_active_intent(intent_id) to load the intent context\n\n` +
				`Only after the handshake is complete can you use "${ctx.toolName}" or any other mutating tool.`,
		}
	}

	/** MCP tools are governed separately and also exempt. */
	private static isExempt(toolName: string): boolean {
		if (EXEMPT_TOOLS.includes(toolName)) {
			return true
		}

		if (toolName.startsWith("mcp_")) {
			return true
		}

		return false
	}
}
