/**
 * SupervisorOrchestrator.ts — Phase 4: Hierarchical Manager-Worker Pattern
 *
 * Implements a Supervisor agent that reads the main specification and
 * spawns isolated sub-agents with narrow scopes. The Supervisor:
 *
 *   1. Decomposes complex tasks into isolated sub-tasks
 *   2. Assigns disjoint file scopes (Write Partitioning) to prevent collisions
 *   3. Injects minimal, compacted context into each sub-agent
 *   4. Awaits completion payloads from sub-agents
 *   5. Validates results against acceptance criteria
 *   6. Merges outcomes back into the master conversation
 *
 * Architecture:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │                    SUPERVISOR AGENT                          │
 *   │  Reads: active_intents.yaml, intent_map.md, spec docs       │
 *   │  Role: Plan → Partition → Spawn → Await → Validate → Merge  │
 *   └──────────────────────────┬───────────────────────────────────┘
 *                              │ spawn isolated sub-agents
 *              ┌───────────────┼───────────────┐
 *              ▼               ▼               ▼
 *     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 *     │ Sub-Agent A  │ │ Sub-Agent B  │ │ Sub-Agent C  │
 *     │ "Architect"  │ │ "Builder"    │ │ "Tester"     │
 *     │ scope: docs/ │ │ scope: src/  │ │ scope: test/ │
 *     └──────────────┘ └──────────────┘ └──────────────┘
 *
 * @see ContextCompactor.ts — prepares compact context for sub-agents
 * @see OptimisticLock.ts — prevents write collisions between sub-agents
 * @see Research Paper: Hierarchical Supervision & State Ledgers
 * @see TRP1 Challenge Week 1, Phase 4: Supervisor Orchestration
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { v4 as uuidv4 } from "uuid"

import { ContextCompactor } from "./ContextCompactor"
import type { ConversationTurn, SubAgentContext } from "./ContextCompactor"

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Role specializations for sub-agents.
 * Based on Boris Cherny's (Anthropic) parallel agent philosophy.
 */
export enum AgentRole {
	ARCHITECT = "ARCHITECT",
	BUILDER = "BUILDER",
	TESTER = "TESTER",
	REVIEWER = "REVIEWER",
	DOCUMENTER = "DOCUMENTER",
}

/**
 * Status of a sub-task in the orchestration lifecycle.
 */
export enum SubTaskStatus {
	PENDING = "PENDING",
	IN_PROGRESS = "IN_PROGRESS",
	COMPLETED = "COMPLETED",
	FAILED = "FAILED",
	BLOCKED = "BLOCKED",
}

/**
 * A sub-task definition that the Supervisor delegates to a sub-agent.
 */
export interface SubTask {
	/** Unique sub-task identifier */
	id: string

	/** Human-readable description */
	description: string

	/** The role/specialization of the sub-agent */
	role: AgentRole

	/** Current status */
	status: SubTaskStatus

	/** Disjoint file scope — only these paths may be modified */
	assignedScope: string[]

	/** The active intent this sub-task is under */
	intentId: string

	/** Prepared context for the sub-agent */
	context: SubAgentContext | null

	/** Result payload from the sub-agent (on completion) */
	completionPayload: SubTaskCompletionPayload | null

	/** ISO timestamp when the sub-task was created */
	createdAt: string

	/** ISO timestamp when the sub-task completed/failed */
	completedAt: string | null

	/** Dependencies — sub-task IDs that must complete before this one */
	dependsOn: string[]

	/** Priority (1 = highest, lower numbers execute first) */
	priority: number
}

/**
 * Completion payload returned by a sub-agent.
 */
export interface SubTaskCompletionPayload {
	/** Files modified by the sub-agent */
	modifiedFiles: string[]

	/** Summary of work performed */
	summary: string

	/** Whether the sub-task succeeded */
	success: boolean

	/** Errors encountered (if any) */
	errors: string[]

	/** Test results (if applicable) */
	testResults?: {
		passed: number
		failed: number
		skipped: number
	}

	/** Lessons learned (fed to CLAUDE.md) */
	lessonsLearned: string[]
}

/**
 * Overall orchestration state maintained by the Supervisor.
 */
export interface OrchestrationState {
	/** Unique orchestration session ID */
	sessionId: string

	/** The master intent being orchestrated */
	masterIntentId: string

	/** All sub-tasks in this orchestration */
	subTasks: SubTask[]

	/** ISO timestamp when orchestration began */
	startedAt: string

	/** ISO timestamp when orchestration completed */
	completedAt: string | null

	/** Overall status */
	status: "PLANNING" | "EXECUTING" | "COMPLETED" | "FAILED"
}

// ── SupervisorOrchestrator ───────────────────────────────────────────────

/**
 * Manages the hierarchical decomposition and orchestration of sub-agents.
 *
 * The Supervisor does NOT execute code itself — it plans, delegates,
 * and validates. Each sub-agent operates in isolation with:
 *   - A narrow file scope (write partitioning)
 *   - A compacted context (via ContextCompactor)
 *   - An assigned role (Architect, Builder, Tester, etc.)
 */
export class SupervisorOrchestrator {
	/** Current orchestration state */
	private _state: OrchestrationState

	/** Workspace root */
	private readonly cwd: string

	/** State ledger path */
	private readonly stateLedgerPath: string

	constructor(cwd: string, masterIntentId: string) {
		this.cwd = cwd
		this.stateLedgerPath = path.join(cwd, ".orchestration", "orchestration_state.json")

		this._state = {
			sessionId: uuidv4(),
			masterIntentId,
			subTasks: [],
			startedAt: new Date().toISOString(),
			completedAt: null,
			status: "PLANNING",
		}
	}

	// ── Sub-Task Management ──────────────────────────────────────────

	/**
	 * Define a new sub-task for delegation to a sub-agent.
	 *
	 * The Supervisor calls this during the planning phase to break
	 * the master intent into isolated, scoped sub-tasks.
	 */
	createSubTask(
		description: string,
		role: AgentRole,
		assignedScope: string[],
		options: {
			dependsOn?: string[]
			priority?: number
		} = {},
	): SubTask {
		const subTask: SubTask = {
			id: `ST-${uuidv4().substring(0, 8)}`,
			description,
			role,
			status: SubTaskStatus.PENDING,
			assignedScope,
			intentId: this._state.masterIntentId,
			context: null,
			completionPayload: null,
			createdAt: new Date().toISOString(),
			completedAt: null,
			dependsOn: options.dependsOn ?? [],
			priority: options.priority ?? 5,
		}

		this._state.subTasks.push(subTask)
		this.persistState()
		return subTask
	}

	/**
	 * Prepare context and mark a sub-task as ready for execution.
	 *
	 * Builds a compacted, scope-restricted context using ContextCompactor.
	 *
	 * @param subTaskId       - The sub-task to prepare
	 * @param parentTurns     - The supervisor's conversation history
	 * @param intentContext   - Active intent XML block
	 */
	prepareSubTask(
		subTaskId: string,
		parentTurns: ConversationTurn[],
		intentContext: string | null,
	): SubAgentContext | null {
		const subTask = this.findSubTask(subTaskId)
		if (!subTask) {
			console.error(`[Supervisor] Sub-task not found: ${subTaskId}`)
			return null
		}

		// Check dependencies
		const unmetDeps = this.getUnmetDependencies(subTask)
		if (unmetDeps.length > 0) {
			subTask.status = SubTaskStatus.BLOCKED
			console.warn(`[Supervisor] Sub-task ${subTaskId} blocked by unmet dependencies: ${unmetDeps.join(", ")}`)
			this.persistState()
			return null
		}

		// Build the task specification for the sub-agent
		const taskSpec = this.buildSubAgentSpec(subTask)

		// Prepare compacted context
		const context = ContextCompactor.prepareSubAgentContext(
			taskSpec,
			subTask.assignedScope,
			parentTurns,
			intentContext,
			this.cwd,
		)

		subTask.context = context
		subTask.status = SubTaskStatus.IN_PROGRESS
		this.persistState()

		console.log(
			`[Supervisor] Prepared sub-task ${subTaskId} (${subTask.role}) ` +
				`with ${context.estimatedTokens} estimated tokens`,
		)

		return context
	}

	/**
	 * Record the completion of a sub-task.
	 */
	completeSubTask(subTaskId: string, payload: SubTaskCompletionPayload): void {
		const subTask = this.findSubTask(subTaskId)
		if (!subTask) {
			console.error(`[Supervisor] Sub-task not found for completion: ${subTaskId}`)
			return
		}

		subTask.completionPayload = payload
		subTask.status = payload.success ? SubTaskStatus.COMPLETED : SubTaskStatus.FAILED
		subTask.completedAt = new Date().toISOString()

		// Check if all sub-tasks are done
		const allDone = this._state.subTasks.every(
			(st) => st.status === SubTaskStatus.COMPLETED || st.status === SubTaskStatus.FAILED,
		)

		if (allDone) {
			const allSuccess = this._state.subTasks.every((st) => st.status === SubTaskStatus.COMPLETED)
			this._state.status = allSuccess ? "COMPLETED" : "FAILED"
			this._state.completedAt = new Date().toISOString()
		}

		this.persistState()

		console.log(`[Supervisor] Sub-task ${subTaskId} ${subTask.status}: ${payload.summary}`)
	}

	// ── Write Partitioning ───────────────────────────────────────────

	/**
	 * Validate that sub-task scopes are disjoint (no overlap).
	 *
	 * This is the "Write Partitioning" strategy from the research paper:
	 * by assigning disjoint file spaces to different sub-agents, we
	 * mathematically eliminate the possibility of spatial overlap.
	 *
	 * @returns Array of conflicts (empty means all scopes are disjoint)
	 */
	validateScopePartitioning(): Array<{ taskA: string; taskB: string; overlap: string[] }> {
		const conflicts: Array<{ taskA: string; taskB: string; overlap: string[] }> = []
		const tasks = this._state.subTasks

		for (let i = 0; i < tasks.length; i++) {
			for (let j = i + 1; j < tasks.length; j++) {
				const overlap = SupervisorOrchestrator.findScopeOverlap(tasks[i].assignedScope, tasks[j].assignedScope)

				if (overlap.length > 0) {
					conflicts.push({
						taskA: tasks[i].id,
						taskB: tasks[j].id,
						overlap,
					})
				}
			}
		}

		return conflicts
	}

	/**
	 * Find overlapping paths between two scope arrays.
	 */
	static findScopeOverlap(scopeA: string[], scopeB: string[]): string[] {
		const overlap: string[] = []

		for (const pathA of scopeA) {
			for (const pathB of scopeB) {
				if (
					SupervisorOrchestrator.scopeContains(pathA, pathB) ||
					SupervisorOrchestrator.scopeContains(pathB, pathA)
				) {
					overlap.push(`${pathA} ↔ ${pathB}`)
				}
			}
		}

		return overlap
	}

	/**
	 * Check if a scope pattern contains (covers) a path.
	 * Simple prefix-based check for directory patterns.
	 */
	private static scopeContains(scopePattern: string, targetPath: string): boolean {
		// Exact match
		if (scopePattern === targetPath) {
			return true
		}

		// Directory glob: "src/auth/**" contains "src/auth/middleware.ts"
		const baseDir = scopePattern.replace(/\*\*$/, "").replace(/\/+$/, "")
		const targetDir = targetPath.replace(/\*\*$/, "").replace(/\/+$/, "")

		return targetDir.startsWith(baseDir + "/") || baseDir.startsWith(targetDir + "/")
	}

	// ── Execution Order ──────────────────────────────────────────────

	/**
	 * Get sub-tasks in priority-based execution order,
	 * respecting dependency constraints (topological sort).
	 */
	getExecutionOrder(): SubTask[] {
		const remaining = [...this._state.subTasks]
		const ordered: SubTask[] = []
		const completed = new Set<string>()

		// Simple topological sort with priority
		while (remaining.length > 0) {
			// Find tasks whose dependencies are all completed
			const ready = remaining
				.filter((t) => t.dependsOn.every((dep) => completed.has(dep)))
				.sort((a, b) => a.priority - b.priority)

			if (ready.length === 0) {
				// Circular dependency — add remaining in priority order
				remaining.sort((a, b) => a.priority - b.priority)
				ordered.push(...remaining)
				break
			}

			const next = ready[0]
			ordered.push(next)
			completed.add(next.id)
			remaining.splice(remaining.indexOf(next), 1)
		}

		return ordered
	}

	// ── State Access ─────────────────────────────────────────────────

	get state(): Readonly<OrchestrationState> {
		return this._state
	}

	get subTasks(): readonly SubTask[] {
		return this._state.subTasks
	}

	get isComplete(): boolean {
		return this._state.status === "COMPLETED" || this._state.status === "FAILED"
	}

	private findSubTask(id: string): SubTask | undefined {
		return this._state.subTasks.find((st) => st.id === id)
	}

	private getUnmetDependencies(task: SubTask): string[] {
		return task.dependsOn.filter((depId) => {
			const dep = this.findSubTask(depId)
			return !dep || dep.status !== SubTaskStatus.COMPLETED
		})
	}

	// ── Sub-Agent Spec Building ──────────────────────────────────────

	/**
	 * Build the system prompt specification for a sub-agent.
	 */
	private buildSubAgentSpec(subTask: SubTask): string {
		return [
			`<sub_agent_specification>`,
			`  <role>${subTask.role}</role>`,
			`  <task_id>${subTask.id}</task_id>`,
			`  <intent_id>${subTask.intentId}</intent_id>`,
			`  <description>${subTask.description}</description>`,
			`  <assigned_scope>`,
			...subTask.assignedScope.map((s) => `    <path>${s}</path>`),
			`  </assigned_scope>`,
			`  <constraints>`,
			`    - You may ONLY modify files within your assigned_scope.`,
			`    - You MUST call select_active_intent("${subTask.intentId}") before any writes.`,
			`    - You MUST declare mutation_class for every file write.`,
			`    - On completion, produce a structured completion payload.`,
			`  </constraints>`,
			`</sub_agent_specification>`,
		].join("\n")
	}

	// ── Persistence ──────────────────────────────────────────────────

	/**
	 * Persist the orchestration state to .orchestration/orchestration_state.json.
	 * This acts as the centralized state ledger from the research paper.
	 */
	private persistState(): void {
		try {
			const stateDir = path.dirname(this.stateLedgerPath)
			if (!fs.existsSync(stateDir)) {
				fs.mkdirSync(stateDir, { recursive: true })
			}
			fs.writeFileSync(this.stateLedgerPath, JSON.stringify(this._state, null, 2), "utf-8")
		} catch (error) {
			console.error(`[Supervisor] Failed to persist state: ${error}`)
		}
	}

	/**
	 * Load orchestration state from disk (for recovery/continuation).
	 */
	static loadState(cwd: string): OrchestrationState | null {
		try {
			const statePath = path.join(cwd, ".orchestration", "orchestration_state.json")
			if (!fs.existsSync(statePath)) {
				return null
			}
			const raw = fs.readFileSync(statePath, "utf-8")
			return JSON.parse(raw) as OrchestrationState
		} catch {
			return null
		}
	}

	/**
	 * Generate a status report of the current orchestration.
	 * Used for the Supervisor's decision-making and monitoring.
	 */
	generateStatusReport(): string {
		const { subTasks, status, masterIntentId, sessionId } = this._state

		const stats = {
			total: subTasks.length,
			pending: subTasks.filter((t) => t.status === SubTaskStatus.PENDING).length,
			inProgress: subTasks.filter((t) => t.status === SubTaskStatus.IN_PROGRESS).length,
			completed: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
			failed: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
			blocked: subTasks.filter((t) => t.status === SubTaskStatus.BLOCKED).length,
		}

		const taskLines = subTasks.map(
			(t) => `  [${t.status.padEnd(12)}] ${t.id} (${t.role}): ${t.description.substring(0, 60)}`,
		)

		return [
			`<orchestration_status>`,
			`  session: ${sessionId}`,
			`  intent: ${masterIntentId}`,
			`  overall_status: ${status}`,
			`  progress: ${stats.completed}/${stats.total} completed, ${stats.failed} failed, ${stats.blocked} blocked`,
			`  sub_tasks:`,
			...taskLines,
			`</orchestration_status>`,
		].join("\n")
	}
}
