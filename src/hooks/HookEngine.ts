/** Central middleware orchestrator for intent-driven tool execution hooks. */

import * as fs from "node:fs"
import * as path from "node:path"
import { parse as parseYaml } from "yaml"

import { IntentContextLoader } from "./IntentContextLoader"
import { GatekeeperHook } from "./PreToolHook"
import { CommandClassifier, RiskTier } from "./CommandClassifier"
import type { ClassificationResult } from "./CommandClassifier"
import { AuthorizationGate, AuthorizationDecision } from "./AuthorizationGate"
import { AutonomousRecovery } from "./AutonomousRecovery"
import { ScopeEnforcer } from "./ScopeEnforcer"
import { PostToolHook } from "./PostToolHook"
import { TraceLogger } from "./TraceLogger"
import { IntentMapWriter } from "./IntentMapWriter"
import { OptimisticLockManager } from "./OptimisticLock"
import { AstPatchValidator } from "./AstPatchValidator"
import { LessonRecorder } from "./LessonRecorder"
import { SpecifyParser } from "./SpecifyParser"
import type { HookContext, PreHookResult, IntentEntry, ActiveIntentsFile } from "./types"
import type { AgentTraceRecord } from "./TraceLogger"

export class HookEngine {
	private readonly preHooks: Array<(ctx: HookContext) => Promise<PreHookResult>>

	private _activeIntentId: string | null = null
	private _intentContextXml: string | null = null
	private _activeIntent: IntentEntry | null = null
	private readonly cwd: string
	private readonly _preWriteContent: Map<string, string> = new Map()
	private readonly _lockManager: OptimisticLockManager
	private _sessionState: string | null = null
	private _sessionStartTime: string | null = null
	private _lastTraceRecord: AgentTraceRecord | null = null

	constructor(cwd: string) {
		this.cwd = cwd
		this._lockManager = new OptimisticLockManager(cwd)
		this.preHooks = [(ctx) => GatekeeperHook.execute(ctx, this), (ctx) => IntentContextLoader.execute(ctx, this)]
		this.startSession()
	}

	async runPreHooks(toolName: string, params: Record<string, unknown>): Promise<PreHookResult> {
		const context: HookContext = {
			toolName,
			params,
			cwd: this.cwd,
			activeIntentId: this._activeIntentId,
		}

		// ── Phase 1 Pre-Hooks ────────────────────────────────────────────
		const phase1Result = await this.runPhase1Hooks(context)
		if (phase1Result.action !== "allow") {
			return phase1Result
		}

		// ── Phase 2: Security Boundary ───────────────────────────────────
		const securityResult = await this.runPhase2SecurityBoundary(toolName, params)
		if (securityResult.action !== "allow") {
			return securityResult
		}

		// ── Phase 4: Concurrency Control ─────────────────────────────────
		const concurrencyResult = this.runPhase4ConcurrencyControl(toolName, params)
		if (concurrencyResult.action !== "allow") {
			return concurrencyResult
		}

		// ── Phase 3: Capture pre-write content for trace comparison ──────
		this.capturePreWriteContent(toolName, params)

		// ── Phase 4: Capture read hash for optimistic locking ────────────
		this.captureReadHashIfNeeded(toolName, params)

		return { action: "allow" }
	}

	private async runPhase1Hooks(context: HookContext): Promise<PreHookResult> {
		for (const hook of this.preHooks) {
			try {
				const result = await hook(context)
				if (result.action === "block" || result.action === "inject") {
					return result
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown hook error"
				console.error(`[HookEngine] Pre-hook error: ${errorMessage}`)
				return {
					action: "block",
					toolResult: AutonomousRecovery.formatHookError(
						context.toolName,
						errorMessage,
						this._activeIntentId,
					),
				}
			}
		}
		return { action: "allow" }
	}

	private async runPhase2SecurityBoundary(toolName: string, params: Record<string, unknown>): Promise<PreHookResult> {
		const classification = CommandClassifier.classify(toolName, params)
		console.log(`[HookEngine] Classification: ${toolName} → ${classification.tier} (${classification.reason})`)

		if (classification.tier === RiskTier.META || classification.tier === RiskTier.SAFE) {
			return { action: "allow" }
		}

		const scopeResult = this.enforceScopeIfNeeded(toolName, params)
		if (scopeResult) {
			return scopeResult
		}

		return this.runAuthorization(toolName, params, classification)
	}

	private enforceScopeIfNeeded(toolName: string, params: Record<string, unknown>): PreHookResult | null {
		if (!CommandClassifier.isFileWriteOperation(toolName) || !this._activeIntent) {
			return null
		}

		const targetPath = ScopeEnforcer.extractTargetPath(toolName, params)
		if (!targetPath) {
			return null
		}

		const scopeCheck = ScopeEnforcer.check(targetPath, this._activeIntent.owned_scope, this.cwd)
		if (scopeCheck.allowed) {
			console.log(`[HookEngine] Scope check passed: ${scopeCheck.reason}`)
			return null
		}

		console.warn(`[HookEngine] SCOPE VIOLATION: ${scopeCheck.reason}`)
		return {
			action: "block",
			toolResult: AutonomousRecovery.formatScopeViolation(
				toolName,
				targetPath,
				this._activeIntent.owned_scope,
				this._activeIntentId,
			),
		}
	}

	private async runAuthorization(
		toolName: string,
		params: Record<string, unknown>,
		classification: ClassificationResult,
	): Promise<PreHookResult> {
		try {
			const authResult = await AuthorizationGate.evaluate(
				classification,
				toolName,
				params,
				this._activeIntentId,
				this.cwd,
			)

			if (authResult.decision === AuthorizationDecision.REJECTED) {
				console.warn(`[HookEngine] REJECTED by user: ${toolName}`)
				return {
					action: "block",
					toolResult: AutonomousRecovery.formatRejection(
						toolName,
						classification,
						authResult.reason,
						this._activeIntentId,
					),
				}
			}

			console.log(`[HookEngine] Authorization: ${authResult.decision} — ${authResult.reason}`)
			return { action: "allow" }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown authorization error"
			console.error(`[HookEngine] Authorization error: ${errorMessage}`)
			return {
				action: "block",
				toolResult: AutonomousRecovery.formatHookError(toolName, errorMessage, this._activeIntentId),
			}
		}
	}

	/** Execute post-tool hooks after successful tool execution. */
	async runPostHooks(toolName: string, params: Record<string, unknown>): Promise<string | null> {
		const feedbackParts: string[] = []

		try {
			const result = await PostToolHook.execute(toolName, params, this.cwd)

			if (result.hasErrors && result.feedback) {
				console.warn(`[HookEngine] Post-hook errors for ${toolName}: ${result.feedback}`)
				feedbackParts.push(result.feedback)
				this.recordLintLessonIfNeeded(toolName, params, result)
			} else if (result.feedback) {
				console.log(`[HookEngine] Post-hook feedback for ${toolName}: ${result.feedback}`)
				feedbackParts.push(result.feedback)
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown post-hook error"
			console.error(`[HookEngine] Post-hook error: ${errorMessage}`)
		}

		try {
			const traceFeedback = await this.recordTraceIfNeeded(toolName, params)
			if (traceFeedback) {
				feedbackParts.push(traceFeedback)
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown trace error"
			console.error(`[HookEngine] Trace recording error: ${errorMessage}`)
		}

		// Phase 3: Update intent_map.md on INTENT_EVOLUTION mutations
		try {
			await this.updateIntentMapIfNeeded(toolName, params)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown intent map error"
			console.error(`[HookEngine] Intent map update error: ${errorMessage}`)
		}

		this.updateLockAfterWrite(toolName, params)

		return feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null
	}

	private static readonly TRACE_TOOLS: ReadonlySet<string> = new Set([
		"write_to_file",
		"apply_diff",
		"edit",
		"search_and_replace",
		"search_replace",
		"edit_file",
		"apply_patch",
	])

	private async recordTraceIfNeeded(toolName: string, params: Record<string, unknown>): Promise<string | null> {
		if (!HookEngine.TRACE_TOOLS.has(toolName)) {
			return null
		}

		// Extract file path from params
		const filePath = this.extractWriteFilePath(toolName, params)
		if (!filePath) {
			return null
		}

		const oldContent = this._preWriteContent.get(filePath) ?? ""

		const newContent = TraceLogger.readOldContent(filePath, this.cwd)
		if (!newContent) {
			return null
		}

		// Record the trace
		const result = await TraceLogger.recordTrace(
			{
				toolName,
				params,
				filePath,
				oldContent,
				newContent,
				activeIntentId: this._activeIntentId,
				agentMutationClass: typeof params.mutation_class === "string" ? params.mutation_class : undefined,
			},
			this.cwd,
		)

		// Update intent_map.md if this was an INTENT_EVOLUTION
		if (result.success && result.record) {
			this._lastTraceRecord = result.record
		}

		// Clean up pre-write cache
		this._preWriteContent.delete(filePath)

		return result.feedback
	}

	/** Updates intent_map.md when the latest trace record is an INTENT_EVOLUTION mutation. */
	private updateIntentMapIfNeeded(toolName: string, _params: Record<string, unknown>): void {
		if (!HookEngine.TRACE_TOOLS.has(toolName)) {
			return
		}

		if (!this._lastTraceRecord) {
			return
		}

		const record = this._lastTraceRecord
		this._lastTraceRecord = null // Consume the record

		const result = IntentMapWriter.update(record, this.cwd)
		if (result.success && result.fileEntryCount > 0) {
			console.log(
				`[HookEngine] Intent map updated: ${result.intentCount} intent(s), ` +
					`${result.fileEntryCount} file(s)`,
			)
		}
	}

	private extractWriteFilePath(toolName: string, params: Record<string, unknown>): string | null {
		// write_to_file uses "path"
		if (typeof params.path === "string") {
			return params.path
		}
		// apply_diff, edit_file, search_and_replace use "file_path"
		if (typeof params.file_path === "string") {
			return params.file_path
		}
		// Fallback: try common param names
		if (typeof params.filePath === "string") {
			return params.filePath
		}
		return null
	}

	capturePreWriteContent(toolName: string, params: Record<string, unknown>): void {
		if (!HookEngine.TRACE_TOOLS.has(toolName)) {
			return
		}

		const filePath = this.extractWriteFilePath(toolName, params)
		if (filePath) {
			const content = TraceLogger.readOldContent(filePath, this.cwd)
			this._preWriteContent.set(filePath, content)
		}
	}

	get activeIntentId(): string | null {
		return this._activeIntentId
	}

	setActiveIntentId(intentId: string): void {
		this._activeIntentId = intentId
		this.loadActiveIntentEntry(intentId)
	}

	get intentContextXml(): string | null {
		return this._intentContextXml
	}

	setIntentContextXml(xml: string): void {
		this._intentContextXml = xml
	}

	get activeIntent(): IntentEntry | null {
		return this._activeIntent
	}

	get lockManager(): OptimisticLockManager {
		return this._lockManager
	}

	clearActiveIntent(): void {
		this._activeIntentId = null
		this._intentContextXml = null
		this._activeIntent = null
		this._lockManager.clearAll()
	}

	hasActiveIntent(): boolean {
		return this._activeIntentId !== null && this._activeIntentId.length > 0
	}

	private runPhase4ConcurrencyControl(toolName: string, params: Record<string, unknown>): PreHookResult {
		if (!CommandClassifier.isFileWriteOperation(toolName)) {
			return { action: "allow" }
		}

		const filePath = this.extractWriteFilePath(toolName, params)
		if (!filePath) {
			return { action: "allow" }
		}

		const lockResult = this._lockManager.validateWrite(filePath)
		if (!lockResult.allowed) {
			console.warn(`[HookEngine] OPTIMISTIC LOCK CONFLICT: ${lockResult.reason}`)

			LessonRecorder.recordLockConflict(
				filePath,
				lockResult.baselineHash,
				lockResult.currentHash,
				this._activeIntentId,
				this.cwd,
			)

			return {
				action: "block",
				toolResult: OptimisticLockManager.formatStaleFileError(
					toolName,
					filePath,
					lockResult,
					this._activeIntentId,
				),
			}
		}

		const oldContent = this._preWriteContent.get(filePath) ?? TraceLogger.readOldContent(filePath, this.cwd)
		const newContent = typeof params.content === "string" ? params.content : null

		if (oldContent && newContent) {
			const patchResult = AstPatchValidator.validate(toolName, oldContent, newContent, params)
			if (!patchResult.valid) {
				console.warn(`[HookEngine] AST PATCH BLOCKED: ${patchResult.reason}`)
				return {
					action: "block",
					toolResult: [
						"<ast_patch_error>",
						`  <error_type>FULL_REWRITE_BLOCKED</error_type>`,
						`  <tool>${toolName}</tool>`,
						`  <file>${filePath}</file>`,
						`  <change_ratio>${(patchResult.changeRatio * 100).toFixed(0)}%</change_ratio>`,
						`  <reason>${patchResult.reason}</reason>`,
						patchResult.guidance ?? "",
						"</ast_patch_error>",
					].join("\n"),
				}
			}
		}

		return { action: "allow" }
	}

	private captureReadHashIfNeeded(toolName: string, params: Record<string, unknown>): void {
		if (toolName === "read_file") {
			let filePath: string | null = null
			if (typeof params.path === "string") {
				filePath = params.path
			} else if (typeof params.file_path === "string") {
				filePath = params.file_path
			}

			if (filePath) {
				this._lockManager.captureReadHash(filePath)
			}
		}

		// Also capture hash for write targets if not already tracked
		if (CommandClassifier.isFileWriteOperation(toolName)) {
			const filePath = this.extractWriteFilePath(toolName, params)
			if (filePath && !this._lockManager.getSnapshot(filePath)) {
				this._lockManager.captureReadHash(filePath)
			}
		}
	}

	private updateLockAfterWrite(toolName: string, params: Record<string, unknown>): void {
		if (!CommandClassifier.isFileWriteOperation(toolName)) {
			return
		}

		const filePath = this.extractWriteFilePath(toolName, params)
		if (filePath) {
			this._lockManager.updateAfterWrite(filePath)
		}
	}

	private recordLintLessonIfNeeded(
		toolName: string,
		params: Record<string, unknown>,
		postResult: { hasErrors: boolean; feedback: string | null; filePath: string | null },
	): void {
		if (!postResult.hasErrors || !postResult.filePath || !postResult.feedback) {
			return
		}

		try {
			const errorLines = postResult.feedback
				.split("\n")
				.filter((line) => line.includes("Line "))
				.map((line) => {
					const match = /Line\s+(\d+):\s*(.+)/.exec(line)
					if (!match) {
						return null
					}
					return { line: Number.parseInt(match[1], 10), message: match[2] }
				})
				.filter((e): e is { line: number; message: string } => e !== null)

			if (errorLines.length > 0) {
				LessonRecorder.recordLintFailure(postResult.filePath, errorLines, this._activeIntentId, this.cwd)
			}
		} catch (error) {
			console.warn(`[HookEngine] Failed to record lint lesson: ${error}`)
		}
	}

	private loadActiveIntentEntry(intentId: string): void {
		try {
			const intentsFilePath = path.join(this.cwd, ".orchestration", "active_intents.yaml")
			const raw = fs.readFileSync(intentsFilePath, "utf-8")
			const parsed = parseYaml(raw) as ActiveIntentsFile

			if (parsed && Array.isArray(parsed.active_intents)) {
				const entry = parsed.active_intents.find((i) => i.id === intentId)
				if (entry) {
					this._activeIntent = entry
					console.log(
						`[HookEngine] Loaded intent entry for scope enforcement: ${entry.id} ` +
							`(scope: ${entry.owned_scope.join(", ")})`,
					)
				}
			}
		} catch (error) {
			console.warn(`[HookEngine] Failed to load intent entry for ${intentId}: ${error}`)
		}
	}

	startSession(): void {
		this._sessionStartTime = new Date().toISOString()
		const tasksPath = path.join(this.cwd, ".orchestration", "TASKS.md")

		try {
			if (fs.existsSync(tasksPath)) {
				this._sessionState = fs.readFileSync(tasksPath, "utf-8")
				console.log(
					`[HookEngine] Session started — loaded prior TASKS.md ` + `(${this._sessionState.length} bytes)`,
				)
			} else {
				this._sessionState = null
				console.log(`[HookEngine] Session started — no prior TASKS.md found (first session)`)
			}
		} catch (error) {
			console.warn(`[HookEngine] Failed to read TASKS.md at session start: ${error}`)
			this._sessionState = null
		}
	}

	/** Write session summary to TASKS.md at session end. */
	endSession(summary?: string): void {
		const tasksPath = path.join(this.cwd, ".orchestration", "TASKS.md")
		const endTime = new Date().toISOString()

		const sections: string[] = [
			`# Session State`,
			``,
			`## Last Session`,
			`- **Started**: ${this._sessionStartTime ?? "unknown"}`,
			`- **Ended**: ${endTime}`,
			`- **Active Intent**: ${this._activeIntentId ?? "none"}`,
			``,
		]

		const specReqs = SpecifyParser.extractRequirements(this.cwd)
		if (specReqs.length > 0) {
			sections.push(
				`## Requirements (.specify/)`,
				...specReqs.map((req) => `- ${req.id}: ${req.name} [${req.status}]`),
				``,
			)
		}

		if (this._activeIntent) {
			sections.push(
				`## Active Intent Details`,
				`- **ID**: ${this._activeIntent.id}`,
				`- **Name**: ${this._activeIntent.name}`,
				`- **Scope**: ${this._activeIntent.owned_scope.join(", ")}`,
				``,
			)
		}

		if (summary) {
			sections.push(`## Summary`, summary, ``)
		}

		try {
			const orchestrationDir = path.join(this.cwd, ".orchestration")
			if (!fs.existsSync(orchestrationDir)) {
				fs.mkdirSync(orchestrationDir, { recursive: true })
			}

			fs.writeFileSync(tasksPath, sections.join("\n"), "utf-8")
			console.log(`[HookEngine] Session ended — wrote TASKS.md (${sections.join("\n").length} bytes)`)
		} catch (error) {
			console.warn(`[HookEngine] Failed to write TASKS.md at session end: ${error}`)
		}
	}

	getSessionContext(): string | null {
		return this._sessionState
	}
}
