import * as fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AgentRole, SubTaskStatus, SupervisorOrchestrator } from "../SupervisorOrchestrator"
import type { SubTaskCompletionPayload } from "../SupervisorOrchestrator"

vi.mock("node:fs")
let uuidCounter = 0
vi.mock("uuid", () => ({
	v4: () => {
		uuidCounter++
		const hex = uuidCounter.toString(16).padStart(8, "0")
		return `${hex}-0000-0000-0000-000000000000`
	},
}))

const CWD = "/workspace"
const INTENT = "intent-master-refactor"

describe("SupervisorOrchestrator", () => {
	let orchestrator: SupervisorOrchestrator

	beforeEach(() => {
		vi.clearAllMocks()
		uuidCounter = 0
		vi.mocked(fs.existsSync).mockReturnValue(true)
		vi.mocked(fs.readFileSync).mockReturnValue("{}")
		orchestrator = new SupervisorOrchestrator(CWD, INTENT)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("createSubTask", () => {
		it("creates a sub-task with correct properties", () => {
			const task = orchestrator.createSubTask("Implement login endpoint", AgentRole.BUILDER, ["src/auth/**"])

			expect(task.id).toMatch(/^ST-/)
			expect(task.description).toBe("Implement login endpoint")
			expect(task.role).toBe(AgentRole.BUILDER)
			expect(task.status).toBe(SubTaskStatus.PENDING)
			expect(task.assignedScope).toEqual(["src/auth/**"])
			expect(task.intentId).toBe(INTENT)
			expect(task.dependsOn).toEqual([])
			expect(task.priority).toBe(5) // default
		})

		it("supports custom priority and dependencies", () => {
			const depTask = orchestrator.createSubTask("Plan architecture", AgentRole.ARCHITECT, ["docs/**"])

			const task = orchestrator.createSubTask("Build feature", AgentRole.BUILDER, ["src/**"], {
				dependsOn: [depTask.id],
				priority: 2,
			})

			expect(task.dependsOn).toEqual([depTask.id])
			expect(task.priority).toBe(2)
		})

		it("adds task to the state's subTasks list", () => {
			orchestrator.createSubTask("Task A", AgentRole.BUILDER, ["a/**"])
			orchestrator.createSubTask("Task B", AgentRole.TESTER, ["b/**"])

			expect(orchestrator.subTasks).toHaveLength(2)
		})

		it("persists state to disk after creation", () => {
			orchestrator.createSubTask("Task", AgentRole.BUILDER, ["src/**"])

			expect(fs.writeFileSync).toHaveBeenCalled()
			const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0]
			expect(writeCall[0]).toContain("orchestration_state.json")
		})
	})

	describe("prepareSubTask", () => {
		it("returns SubAgentContext with task spec", () => {
			const task = orchestrator.createSubTask("Write tests for auth", AgentRole.TESTER, ["src/auth/__tests__/**"])

			vi.mocked(fs.existsSync).mockReturnValue(false) // no files to read

			const context = orchestrator.prepareSubTask(task.id, [], null)

			expect(context).not.toBeNull()
			expect(context!.taskSpec).toContain("Write tests for auth")
			expect(context!.taskSpec).toContain(AgentRole.TESTER)
		})

		it("marks sub-task as IN_PROGRESS", () => {
			const task = orchestrator.createSubTask("Build", AgentRole.BUILDER, ["src/**"])

			vi.mocked(fs.existsSync).mockReturnValue(false)
			orchestrator.prepareSubTask(task.id, [], null)

			const updated = orchestrator.subTasks.find((t) => t.id === task.id)
			expect(updated!.status).toBe(SubTaskStatus.IN_PROGRESS)
		})

		it("returns null for non-existent sub-task", () => {
			const result = orchestrator.prepareSubTask("ST-nonexistent", [], null)
			expect(result).toBeNull()
		})

		it("blocks task with unmet dependencies", () => {
			const depTask = orchestrator.createSubTask("Plan", AgentRole.ARCHITECT, ["docs/**"])

			const buildTask = orchestrator.createSubTask("Build", AgentRole.BUILDER, ["src/**"], {
				dependsOn: [depTask.id],
			})

			vi.mocked(fs.existsSync).mockReturnValue(false)
			const result = orchestrator.prepareSubTask(buildTask.id, [], null)

			expect(result).toBeNull()
			const updated = orchestrator.subTasks.find((t) => t.id === buildTask.id)
			expect(updated!.status).toBe(SubTaskStatus.BLOCKED)
		})
	})

	describe("completeSubTask", () => {
		it("marks task as COMPLETED on success", () => {
			const task = orchestrator.createSubTask("Task", AgentRole.BUILDER, ["src/**"])

			const payload: SubTaskCompletionPayload = {
				success: true,
				summary: "All endpoints implemented",
				modifiedFiles: ["src/api/routes.ts"],
				errors: [],
				lessonsLearned: [],
				testResults: { passed: 5, failed: 0, skipped: 0 },
			}

			orchestrator.completeSubTask(task.id, payload)

			const updated = orchestrator.subTasks.find((t) => t.id === task.id)
			expect(updated!.status).toBe(SubTaskStatus.COMPLETED)
			expect(updated!.completedAt).toBeTruthy()
			expect(updated!.completionPayload).toEqual(payload)
		})

		it("marks task as FAILED on failure", () => {
			const task = orchestrator.createSubTask("Task", AgentRole.TESTER, ["tests/**"])

			orchestrator.completeSubTask(task.id, {
				success: false,
				summary: "3 tests failed",
				modifiedFiles: [],
				errors: ["assertion error in test 1", "assertion error in test 2", "assertion error in test 3"],
				lessonsLearned: [],
				testResults: { passed: 7, failed: 3, skipped: 0 },
			})

			const updated = orchestrator.subTasks.find((t) => t.id === task.id)
			expect(updated!.status).toBe(SubTaskStatus.FAILED)
		})

		it("sets overall status to COMPLETED when all succeed", () => {
			const t1 = orchestrator.createSubTask("A", AgentRole.BUILDER, ["a/**"])
			const t2 = orchestrator.createSubTask("B", AgentRole.TESTER, ["b/**"])

			orchestrator.completeSubTask(t1.id, {
				success: true,
				summary: "Done",
				modifiedFiles: [],
				errors: [],
				lessonsLearned: [],
			})
			orchestrator.completeSubTask(t2.id, {
				success: true,
				summary: "Done",
				modifiedFiles: [],
				errors: [],
				lessonsLearned: [],
			})

			expect(orchestrator.state.status).toBe("COMPLETED")
			expect(orchestrator.isComplete).toBe(true)
		})

		it("sets overall status to FAILED when any task fails", () => {
			const t1 = orchestrator.createSubTask("A", AgentRole.BUILDER, ["a/**"])
			const t2 = orchestrator.createSubTask("B", AgentRole.TESTER, ["b/**"])

			orchestrator.completeSubTask(t1.id, {
				success: true,
				summary: "OK",
				modifiedFiles: [],
				errors: [],
				lessonsLearned: [],
			})
			orchestrator.completeSubTask(t2.id, {
				success: false,
				summary: "Fail",
				modifiedFiles: [],
				errors: ["test failure"],
				lessonsLearned: [],
			})

			expect(orchestrator.state.status).toBe("FAILED")
		})
	})

	describe("validateScopePartitioning", () => {
		it("returns empty array for disjoint scopes", () => {
			orchestrator.createSubTask("Auth", AgentRole.BUILDER, ["src/auth/**"])
			orchestrator.createSubTask("API", AgentRole.BUILDER, ["src/api/**"])
			orchestrator.createSubTask("Tests", AgentRole.TESTER, ["tests/**"])

			const conflicts = orchestrator.validateScopePartitioning()
			expect(conflicts).toEqual([])
		})

		it("detects overlapping scopes", () => {
			orchestrator.createSubTask("Auth Builder", AgentRole.BUILDER, ["src/auth/**"])
			orchestrator.createSubTask("Auth Tester", AgentRole.TESTER, ["src/auth/**"])

			const conflicts = orchestrator.validateScopePartitioning()
			expect(conflicts.length).toBeGreaterThan(0)
			expect(conflicts[0].overlap.length).toBeGreaterThan(0)
		})

		it("detects partial scope overlaps (parent-child)", () => {
			orchestrator.createSubTask("Wide", AgentRole.BUILDER, ["src/**"])
			orchestrator.createSubTask("Narrow", AgentRole.BUILDER, ["src/auth/**"])

			const conflicts = orchestrator.validateScopePartitioning()
			expect(conflicts.length).toBeGreaterThan(0)
		})
	})

	describe("findScopeOverlap", () => {
		it("detects exact path overlap", () => {
			const overlap = SupervisorOrchestrator.findScopeOverlap(["src/auth/login.ts"], ["src/auth/login.ts"])
			expect(overlap.length).toBeGreaterThan(0)
		})

		it("detects directory containment overlap", () => {
			const overlap = SupervisorOrchestrator.findScopeOverlap(["src/auth/**"], ["src/auth/middleware/**"])
			expect(overlap.length).toBeGreaterThan(0)
		})

		it("returns empty for disjoint paths", () => {
			const overlap = SupervisorOrchestrator.findScopeOverlap(["src/auth/**"], ["src/api/**"])
			expect(overlap).toEqual([])
		})
	})

	describe("getExecutionOrder", () => {
		it("respects dependency ordering", () => {
			const plan = orchestrator.createSubTask("Plan", AgentRole.ARCHITECT, ["docs/**"], { priority: 1 })
			const build = orchestrator.createSubTask("Build", AgentRole.BUILDER, ["src/**"], {
				dependsOn: [plan.id],
				priority: 2,
			})
			const test = orchestrator.createSubTask("Test", AgentRole.TESTER, ["tests/**"], {
				dependsOn: [build.id],
				priority: 3,
			})

			const order = orchestrator.getExecutionOrder()

			expect(order[0].id).toBe(plan.id)
			expect(order[1].id).toBe(build.id)
			expect(order[2].id).toBe(test.id)
		})

		it("sorts by priority when no dependencies", () => {
			orchestrator.createSubTask("Low", AgentRole.DOCUMENTER, ["docs/**"], { priority: 10 })
			orchestrator.createSubTask("High", AgentRole.BUILDER, ["src/**"], { priority: 1 })

			const order = orchestrator.getExecutionOrder()
			expect(order[0].priority).toBeLessThan(order[1].priority)
		})
	})

	describe("generateStatusReport", () => {
		it("produces structured XML status report", () => {
			orchestrator.createSubTask("Task 1", AgentRole.BUILDER, ["src/**"])
			orchestrator.createSubTask("Task 2", AgentRole.TESTER, ["tests/**"])

			const report = orchestrator.generateStatusReport()

			expect(report).toContain("<orchestration_status>")
			expect(report).toContain(INTENT)
			expect(report).toContain("PLANNING")
			expect(report).toContain("0/2 completed")
			expect(report).toContain(AgentRole.BUILDER)
			expect(report).toContain(AgentRole.TESTER)
			expect(report).toContain("</orchestration_status>")
		})

		it("reflects completion progress", () => {
			const t1 = orchestrator.createSubTask("A", AgentRole.BUILDER, ["a/**"])
			orchestrator.createSubTask("B", AgentRole.TESTER, ["b/**"])

			orchestrator.completeSubTask(t1.id, {
				success: true,
				summary: "Done",
				modifiedFiles: [],
				errors: [],
				lessonsLearned: [],
			})

			const report = orchestrator.generateStatusReport()
			expect(report).toContain("1/2 completed")
		})
	})

	describe("state accessors", () => {
		it("exposes readonly state", () => {
			expect(orchestrator.state.masterIntentId).toBe(INTENT)
			expect(orchestrator.state.status).toBe("PLANNING")
		})

		it("exposes readonly subTasks", () => {
			orchestrator.createSubTask("X", AgentRole.BUILDER, ["x/**"])
			expect(orchestrator.subTasks).toHaveLength(1)
		})

		it("isComplete reflects terminal states", () => {
			expect(orchestrator.isComplete).toBe(false)
		})
	})

	describe("AgentRole", () => {
		it("has all expected roles", () => {
			expect(AgentRole.ARCHITECT).toBe("ARCHITECT")
			expect(AgentRole.BUILDER).toBe("BUILDER")
			expect(AgentRole.TESTER).toBe("TESTER")
			expect(AgentRole.REVIEWER).toBe("REVIEWER")
			expect(AgentRole.DOCUMENTER).toBe("DOCUMENTER")
		})
	})

	describe("SubTaskStatus", () => {
		it("has all expected statuses", () => {
			expect(SubTaskStatus.PENDING).toBe("PENDING")
			expect(SubTaskStatus.IN_PROGRESS).toBe("IN_PROGRESS")
			expect(SubTaskStatus.COMPLETED).toBe("COMPLETED")
			expect(SubTaskStatus.FAILED).toBe("FAILED")
			expect(SubTaskStatus.BLOCKED).toBe("BLOCKED")
		})
	})

	describe("loadState", () => {
		it("returns null when state file does not exist", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false)
			const state = SupervisorOrchestrator.loadState(CWD)
			expect(state).toBeNull()
		})

		it("loads state from disk when file exists", () => {
			const mockState = {
				sessionId: "test-session",
				masterIntentId: "test-intent",
				subTasks: [],
				startedAt: "2025-01-15T00:00:00Z",
				completedAt: null,
				status: "PLANNING",
			}

			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockState))

			const loaded = SupervisorOrchestrator.loadState(CWD)

			expect(loaded).not.toBeNull()
			expect(loaded!.sessionId).toBe("test-session")
			expect(loaded!.masterIntentId).toBe("test-intent")
		})

		it("returns null on parse error", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("not json!")

			const state = SupervisorOrchestrator.loadState(CWD)
			expect(state).toBeNull()
		})
	})
})
