/** Pre-hook that loads intent context when select_active_intent is called. */

import * as fs from "node:fs"
import * as path from "node:path"
import { parse as parseYaml } from "yaml"

import type { HookContext, PreHookResult, ActiveIntentsFile, IntentEntry } from "./types"
import type { HookEngine } from "./HookEngine"
import { SpecifyParser } from "./SpecifyParser"

export class IntentContextLoader {
	static async execute(ctx: HookContext, engine: HookEngine): Promise<PreHookResult> {
		if (ctx.toolName !== "select_active_intent") {
			return { action: "allow" }
		}

		const intentId = (ctx.params as { intent_id?: string }).intent_id

		if (!intentId || intentId.trim().length === 0) {
			return {
				action: "block",
				toolResult:
					"[Intent Error] Missing required parameter: intent_id. " +
					"You must provide a valid intent ID from .orchestration/active_intents.yaml.",
			}
		}

		try {
			const intentsFilePath = path.join(ctx.cwd, ".orchestration", "active_intents.yaml")
			const intents = await IntentContextLoader.readIntentsFile(intentsFilePath)

			const matchingIntent = intents.active_intents.find((intent) => intent.id === intentId.trim())

			if (!matchingIntent) {
				// Fallback: try .specify/ markdown files
				const specReq = SpecifyParser.findRequirement(ctx.cwd, intentId.trim())
				if (specReq) {
					const specIntent = SpecifyParser.toIntentEntry(specReq) as IntentEntry
					const contextXml = IntentContextLoader.buildIntentContextXml(specIntent)

					engine.setActiveIntentId(specIntent.id)
					engine.setIntentContextXml(contextXml)

					console.log(
						`[IntentContextLoader] Activated intent from .specify/: ` +
							`${specIntent.id} — ${specIntent.name} (source: ${specReq.sourceFile})`,
					)

					return {
						action: "inject",
						toolResult: contextXml,
					}
				}

				const availableIds = intents.active_intents
					.map((i) => `  - ${i.id}: ${i.name} [${i.status}]`)
					.join("\n")

				const specReqs = SpecifyParser.extractRequirements(ctx.cwd)
				const specIds =
					specReqs.length > 0
						? "\n\nAlso available from .specify/ directory:\n" +
							specReqs.map((r) => `  - ${r.id}: ${r.name} [${r.status}]`).join("\n")
						: ""

				return {
					action: "block",
					toolResult:
						`[Intent Error] No intent found with ID "${intentId}". ` +
						`Available intents:\n${availableIds}${specIds}\n\n` +
						`Please call select_active_intent with a valid intent_id.`,
				}
			}

			const contextXml = IntentContextLoader.buildIntentContextXml(matchingIntent)

			engine.setActiveIntentId(matchingIntent.id)
			engine.setIntentContextXml(contextXml)

			console.log(`[IntentContextLoader] Activated intent: ${matchingIntent.id} — ${matchingIntent.name}`)

			return {
				action: "inject",
				toolResult: contextXml,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"

			if (errorMessage.includes("ENOENT") || errorMessage.includes("no such file")) {
				return {
					action: "block",
					toolResult:
						`[Intent Error] File not found: .orchestration/active_intents.yaml\n\n` +
						`This file must exist at the workspace root to use intent-driven architecture.\n` +
						`Please ask the user to create .orchestration/active_intents.yaml with their intent definitions.`,
				}
			}

			return {
				action: "block",
				toolResult: `[Intent Error] Failed to load intent context: ${errorMessage}`,
			}
		}
	}

	private static async readIntentsFile(filePath: string): Promise<ActiveIntentsFile> {
		const raw = fs.readFileSync(filePath, "utf-8")
		const parsed = parseYaml(raw) as ActiveIntentsFile

		if (!parsed || !Array.isArray(parsed.active_intents)) {
			throw new Error(
				"Malformed active_intents.yaml: expected root key 'active_intents' with an array of intent entries.",
			)
		}

		return parsed
	}

	static buildIntentContextXml(intent: IntentEntry): string {
		const constraintsXml = intent.constraints.map((c) => `    <constraint>${escapeXml(c)}</constraint>`).join("\n")

		const scopeXml = intent.owned_scope.map((s) => `    <path>${escapeXml(s)}</path>`).join("\n")

		const criteriaXml = intent.acceptance_criteria
			.map((a) => `    <criterion>${escapeXml(a)}</criterion>`)
			.join("\n")

		return `<intent_context>
  <intent id="${escapeXml(intent.id)}" name="${escapeXml(intent.name)}" status="${escapeXml(intent.status)}">
    <constraints>
${constraintsXml}
    </constraints>
    <owned_scope>
${scopeXml}
    </owned_scope>
    <acceptance_criteria>
${criteriaXml}
    </acceptance_criteria>
  </intent>
  <instruction>
    You are now operating under Intent "${escapeXml(intent.id)}: ${escapeXml(intent.name)}".
    You MUST respect all constraints listed above.
    You may ONLY modify files matching the owned_scope patterns.
    Your work is complete when ALL acceptance_criteria are satisfied.
    Any tool call outside the owned_scope will be BLOCKED by the Gatekeeper.
  </instruction>
</intent_context>`
	}
}

function escapeXml(str: string): string {
	return str
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;")
}
