/** Serializes Agent Trace records and persists them to `.orchestration/agent_trace.jsonl`. */

import * as fs from "node:fs"
import * as path from "node:path"
import { v4 as uuidv4 } from "uuid"
import simpleGit from "simple-git"

import { HashUtils } from "./HashUtils"
import { SemanticClassifier, MutationClass } from "./SemanticClassifier"
import type { MutationClassification } from "./SemanticClassifier"

export interface AgentTraceRecord {
	id: string
	timestamp: string
	vcs: VcsMetadata
	files: TracedFile[]
	mutation: MutationMetadata
}

export interface VcsMetadata {
	revision_id: string
}

export interface TracedFile {
	relative_path: string
	conversations: TraceConversation[]
}

export interface TraceConversation {
	url: string
	contributor: TraceContributor
	ranges: TraceRange[]
	related: TraceRelated[]
}

export interface TraceContributor {
	entity_type: "AI" | "Human" | "Mixed" | "Unknown"
	model_identifier: string
}

export interface TraceRange {
	start_line: number
	end_line: number
	content_hash: string
}

export interface TraceRelated {
	type: string
	value: string
}

export interface MutationMetadata {
	mutation_class: MutationClass
	score: number
	reasoning: string
}

export interface TraceInput {
	toolName: string
	params: Record<string, unknown>
	filePath: string
	oldContent: string
	newContent: string
	activeIntentId: string | null
	modelIdentifier?: string
	sessionUrl?: string
	agentMutationClass?: string
}

export interface TraceResult {
	success: boolean
	record: AgentTraceRecord | null
	classification: MutationClassification | null
	error?: string
	feedback: string
}

const TRACE_FILE = ".orchestration/agent_trace.jsonl"
const DEFAULT_MODEL = "unknown/model"
const DEFAULT_SESSION_URL = "local://roo-code-session"

/** Records Agent Trace entries to `.orchestration/agent_trace.jsonl`. */
export class TraceLogger {
	static async recordTrace(input: TraceInput, cwd: string): Promise<TraceResult> {
		try {
			const classification = TraceLogger.classifyMutation(input)
			const hashResult = HashUtils.hashContent(input.newContent)
			const gitSha = await TraceLogger.getGitSha(cwd)
			const record = TraceLogger.buildTraceRecord(input, classification, hashResult.hash, gitSha)
			TraceLogger.appendToLedger(record, cwd)
			const feedback = TraceLogger.buildFeedback(record, classification)

			console.log(
				`[TraceLogger] Recorded trace: ${record.id} | ` +
					`${input.filePath} | ${classification.mutationClass} | ` +
					`hash=${hashResult.hash.substring(0, 20)}...`,
			)

			return {
				success: true,
				record,
				classification,
				feedback,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown trace error"
			console.error(`[TraceLogger] Failed to record trace: ${errorMessage}`)
			return {
				success: false,
				record: null,
				classification: null,
				error: errorMessage,
				feedback: `[Trace Warning] Failed to record trace for ${input.filePath}: ${errorMessage}`,
			}
		}
	}

	private static classifyMutation(input: TraceInput): MutationClassification {
		if (input.agentMutationClass) {
			return SemanticClassifier.classifyWithOverride(input.agentMutationClass, input.oldContent, input.newContent)
		}
		return SemanticClassifier.classify(input.oldContent, input.newContent)
	}

	private static buildTraceRecord(
		input: TraceInput,
		classification: MutationClassification,
		contentHash: string,
		gitSha: string,
	): AgentTraceRecord {
		const lineCount = input.newContent.split("\n").length
		const related: TraceRelated[] = input.activeIntentId
			? [{ type: "specification", value: input.activeIntentId }]
			: []

		return {
			id: uuidv4(),
			timestamp: new Date().toISOString(),
			vcs: {
				revision_id: gitSha,
			},
			files: [
				{
					relative_path: TraceLogger.normalizeFilePath(input.filePath),
					conversations: [
						{
							url: input.sessionUrl ?? DEFAULT_SESSION_URL,
							contributor: {
								entity_type: "AI",
								model_identifier: input.modelIdentifier ?? DEFAULT_MODEL,
							},
							ranges: [
								{
									start_line: 1,
									end_line: lineCount,
									content_hash: contentHash,
								},
							],
							related,
						},
					],
				},
			],
			mutation: {
				mutation_class: classification.mutationClass,
				score: Number(classification.score.toFixed(4)),
				reasoning: classification.reasoning,
			},
		}
	}

	private static async getGitSha(cwd: string): Promise<string> {
		try {
			const git = simpleGit(cwd)
			const sha = await git.revparse(["HEAD"])
			return sha.trim()
		} catch {
			console.warn("[TraceLogger] Could not read Git SHA — using placeholder")
			return "no-git-sha"
		}
	}

	private static appendToLedger(record: AgentTraceRecord, cwd: string): void {
		const tracePath = path.join(cwd, TRACE_FILE)
		const traceDir = path.dirname(tracePath)

		if (!fs.existsSync(traceDir)) {
			fs.mkdirSync(traceDir, { recursive: true })
		}

		fs.appendFileSync(tracePath, JSON.stringify(record) + "\n", "utf-8")
	}

	private static buildFeedback(record: AgentTraceRecord, classification: MutationClassification): string {
		const file = record.files[0]
		const range = file.conversations[0].ranges[0]
		const related = file.conversations[0].related

		const relatedStr = related.length > 0 ? related.map((r) => `${r.type}=${r.value}`).join(", ") : "none"

		return [
			"<trace_recorded>",
			`  trace_id: ${record.id}`,
			`  file: ${file.relative_path}`,
			`  mutation_class: ${classification.mutationClass}`,
			`  classification_score: ${classification.score.toFixed(3)}`,
			`  content_hash: ${range.content_hash.substring(0, 30)}...`,
			`  git_sha: ${record.vcs.revision_id.substring(0, 8)}...`,
			`  related: [${relatedStr}]`,
			`  reasoning: ${classification.reasoning}`,
			"</trace_recorded>",
		].join("\n")
	}

	private static normalizeFilePath(filePath: string): string {
		const normalized = filePath.replaceAll("\\", "/")
		return normalized.startsWith("./") ? normalized.substring(2) : normalized
	}

	static readOldContent(filePath: string, cwd: string): string {
		try {
			const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
			if (fs.existsSync(absolutePath)) {
				return fs.readFileSync(absolutePath, "utf-8")
			}
		} catch {
			// File doesn't exist or can't be read — treat as new file
		}
		return ""
	}
}
