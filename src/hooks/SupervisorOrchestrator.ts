/** Hierarchical manager-worker orchestrator that decomposes tasks into scoped sub-agents. */

import * as fs from "node:fs"
import * as path from "node:path"
import { v4 as uuidv4 } from "uuid"

import { ContextCompactor } from "./ContextCompactor"
import type { ConversationTurn, SubAgentContext } from "./ContextCompactor"

/** Role specializations for sub-agents. */
export enum AgentRole {
	ARCHITECT = "ARCHITECT",
	BUILDER = "BUILDER",
	TESTER = "TESTER",
	REVIEWER = "REVIEWER",
	DOCUMENTER = "DOCUMENTER",
}

/** Status of a sub-task in the orchestration lifecycle. */
export enum SubTaskStatus {
	PENDING = "PENDING",
	IN_PROGRESS = "IN_PROGRESS",
	COMPLETED = "COMPLETED",
	FAILED = "FAILED",
	BLOCKED = "BLOCKED",
}

/** A sub-task definition that the Supervisor delegates to a sub-agent. */
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

/** Completion payload returned by a sub-agent. */
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

/** Overall orchestration state maintained by the Supervisor. */
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

export class SupervisorOrchestrator {
	/** Current orchestration state */
	private readonly _state: OrchestrationState

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

	/** Prepare context and mark a sub-task as ready for execution. */
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

		const unmetDeps = this.getUnmetDependencies(subTask)
		if (unmetDeps.length > 0) {
			subTask.status = SubTaskStatus.BLOCKED
			console.warn(`[Supervisor] Sub-task ${subTaskId} blocked by unmet dependencies: ${unmetDeps.join(", ")}`)
			this.persistState()
			return null
		}

		const taskSpec = this.buildSubAgentSpec(subTask)

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

	completeSubTask(subTaskId: string, payload: SubTaskCompletionPayload): void {
		const subTask = this.findSubTask(subTaskId)
		if (!subTask) {
			console.error(`[Supervisor] Sub-task not found for completion: ${subTaskId}`)
			return
		}

		subTask.completionPayload = payload
		subTask.status = payload.success ? SubTaskStatus.COMPLETED : SubTaskStatus.FAILED
		subTask.completedAt = new Date().toISOString()

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

	/** Validate that sub-task scopes are disjoint (no overlap). */
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

	/** Check if a scope pattern contains (covers) a path via prefix matching. */
	private static scopeContains(scopePattern: string, targetPath: string): boolean {
		if (scopePattern === targetPath) {
			return true
		}

		const baseDir = scopePattern.replace(/\*\*$/, "").replace(/\/+$/, "")
		const targetDir = targetPath.replace(/\*\*$/, "").replace(/\/+$/, "")

		return targetDir.startsWith(baseDir + "/") || baseDir.startsWith(targetDir + "/")
	}

	/** Get sub-tasks in execution order (topological sort by dependencies, then priority). */
	getExecutionOrder(): SubTask[] {
		const remaining = [...this._state.subTasks]
		const ordered: SubTask[] = []
		const completed = new Set<string>()

		while (remaining.length > 0) {
			const ready = remaining
				.filter((t) => t.dependsOn.every((dep) => completed.has(dep)))
				.sort((a, b) => a.priority - b.priority)

			if (ready.length === 0) {
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
			return !dep?.status || dep.status !== SubTaskStatus.COMPLETED
		})
	}

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
