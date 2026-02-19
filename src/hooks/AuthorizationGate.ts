/** UI-blocking human-in-the-loop authorization gate for destructive/critical operations. */

import * as vscode from "vscode"
import * as fs from "node:fs"
import * as path from "node:path"

import { RiskTier, type ClassificationResult } from "./CommandClassifier"

export enum AuthorizationDecision {
	/** User approved the operation */
	APPROVED = "APPROVED",

	/** User rejected the operation */
	REJECTED = "REJECTED",

	/** Operation was auto-approved (safe tier or .intentignore bypass) */
	AUTO_APPROVED = "AUTO_APPROVED",
}

export interface AuthorizationResult {
	decision: AuthorizationDecision
	reason: string
}

/**
 * Loads `.orchestration/.intentignore` to auto-approve specific intents.
 * Lines list intent IDs; `#` lines and blanks are ignored.
 */
class IntentIgnoreLoader {
	private static readonly cache: Map<string, Set<string>> = new Map()

	static load(cwd: string): Set<string> {
		if (IntentIgnoreLoader.cache.has(cwd)) {
			return IntentIgnoreLoader.cache.get(cwd)!
		}

		const ignorePath = path.join(cwd, ".orchestration", ".intentignore")
		const ignoredIntents = new Set<string>()

		try {
			if (fs.existsSync(ignorePath)) {
				const content = fs.readFileSync(ignorePath, "utf-8")
				const lines = content.split("\n")

				for (const line of lines) {
					const trimmed = line.trim()
					if (trimmed.length === 0 || trimmed.startsWith("#")) {
						continue
					}
					ignoredIntents.add(trimmed)
				}

				console.log(
					`[IntentIgnore] Loaded ${ignoredIntents.size} bypassed intents: ${Array.from(ignoredIntents).join(", ")}`,
				)
			}
		} catch (error) {
			console.warn(`[IntentIgnore] Failed to load .intentignore: ${error}`)
		}

		IntentIgnoreLoader.cache.set(cwd, ignoredIntents)
		return ignoredIntents
	}

	static clearCache(): void {
		IntentIgnoreLoader.cache.clear()
	}

	static isIgnored(cwd: string, intentId: string): boolean {
		const ignored = IntentIgnoreLoader.load(cwd)
		return ignored.has(intentId)
	}
}

export class AuthorizationGate {
	static async evaluate(
		classification: ClassificationResult,
		toolName: string,
		params: Record<string, unknown>,
		activeIntentId: string | null,
		cwd: string,
	): Promise<AuthorizationResult> {
		if (classification.tier === RiskTier.SAFE || classification.tier === RiskTier.META) {
			return {
				decision: AuthorizationDecision.AUTO_APPROVED,
				reason: `Auto-approved: ${classification.reason}`,
			}
		}

		if (
			classification.tier !== RiskTier.CRITICAL &&
			activeIntentId &&
			IntentIgnoreLoader.isIgnored(cwd, activeIntentId)
		) {
			return {
				decision: AuthorizationDecision.AUTO_APPROVED,
				reason: `Auto-approved: Intent "${activeIntentId}" is listed in .intentignore.`,
			}
		}

		return AuthorizationGate.showAuthorizationDialog(classification, toolName, params, activeIntentId)
	}

	private static async showAuthorizationDialog(
		classification: ClassificationResult,
		toolName: string,
		params: Record<string, unknown>,
		activeIntentId: string | null,
	): Promise<AuthorizationResult> {
		const tierLabel = classification.tier === RiskTier.CRITICAL ? "⛔ CRITICAL" : "⚠️ DESTRUCTIVE"
		const intentLabel = activeIntentId ? `Intent: ${activeIntentId}` : "No active intent"

		let message = `[Hook Engine — ${tierLabel}]\n\n`
		message += `Tool: ${toolName}\n`
		message += `${intentLabel}\n`
		message += `Reason: ${classification.reason}\n`

		if (toolName === "execute_command" && params.command) {
			message += `Command: ${typeof params.command === "string" ? params.command.substring(0, 200) : "unknown"}\n`
		} else if (params.path || params.file_path) {
			message += `File: ${String(params.path ?? params.file_path)}\n`
		}

		if (classification.matchedPattern) {
			message += `\n⛔ Critical pattern: ${classification.matchedPattern}`
		}

		message += `\n\nApprove this operation?`

		const approve = "✅ Approve"
		const reject = "❌ Reject"

		const selection = await vscode.window.showWarningMessage(
			message,
			{
				modal: true,
				detail: `The AI agent is requesting permission to perform a ${classification.tier} operation.`,
			},
			approve,
			reject,
		)

		if (selection === approve) {
			console.log(`[AuthorizationGate] APPROVED: ${toolName} (${classification.tier})`)
			return {
				decision: AuthorizationDecision.APPROVED,
				reason: `User approved ${classification.tier} operation: ${toolName}`,
			}
		}

		console.log(`[AuthorizationGate] REJECTED: ${toolName} (${classification.tier})`)
		return {
			decision: AuthorizationDecision.REJECTED,
			reason: `User rejected ${classification.tier} operation: ${toolName}. ${classification.reason}`,
		}
	}

	static clearIgnoreCache(): void {
		IntentIgnoreLoader.clearCache()
	}
}
