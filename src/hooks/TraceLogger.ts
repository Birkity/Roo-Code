/**
 * TraceLogger.ts — Phase 3: Agent Trace Serialization & Sidecar Persistence
 *
 * Builds Agent Trace JSON records (per agent-trace.dev spec), injects the
 * active Requirement ID into `related` (the "golden thread"), computes
 * SHA-256 content hashes, classifies mutations, and appends each record
 * to `.orchestration/agent_trace.jsonl` anchored to the current Git SHA.
 *
 * @see HashUtils.ts — content hashing
 * @see SemanticClassifier.ts — mutation classification
 * @see HookEngine.ts — orchestrates post-hook execution
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { v4 as uuidv4 } from "uuid"
import simpleGit from "simple-git"

import { HashUtils } from "./HashUtils"
import { SemanticClassifier, MutationClass } from "./SemanticClassifier"
import type { MutationClassification } from "./SemanticClassifier"

// ── Agent Trace Schema Types ─────────────────────────────────────────────

/** Root-level Agent Trace record per the specification. */
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

// ── TraceLogger Input ────────────────────────────────────────────────────

/** Input parameters for recording a trace event. */
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

/** Result from recording a trace. */
export interface TraceResult {
	success: boolean
	record: AgentTraceRecord | null
	classification: MutationClassification | null
	error?: string
	feedback: string
}

// ── Constants ────────────────────────────────────────────────────────────

/** Default path for the agent trace ledger */
const TRACE_FILE = ".orchestration/agent_trace.jsonl"

/** Default model identifier when none is provided */
const DEFAULT_MODEL = "unknown/model"

/** Default session URL placeholder */
const DEFAULT_SESSION_URL = "local://roo-code-session"

// ── TraceLogger ──────────────────────────────────────────────────────────

/**
 * Records Agent Trace entries to `.orchestration/agent_trace.jsonl`.
 *
 * This is the post-hook that fires after every file-writing tool execution,
 * building the "AI-Native Git Layer" that links Intent → Code → Hash.
 */
export class TraceLogger {
	/**
	 * Record a trace event for a file modification.
	 *
	 * This is the primary entry point called by HookEngine.runPostHooks()
	 * after a write_to_file, apply_diff, or similar tool completes.
	 *
	 * @param input - All data needed to build the trace record
	 * @param cwd   - Workspace root path
	 * @returns TraceResult with the persisted record and feedback
	 */
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

	// ── Classification ───────────────────────────────────────────────

	private static classifyMutation(input: TraceInput): MutationClassification {
		if (input.agentMutationClass) {
			return SemanticClassifier.classifyWithOverride(input.agentMutationClass, input.oldContent, input.newContent)
		}
		return SemanticClassifier.classify(input.oldContent, input.newContent)
	}

	// ── Trace Record Building ────────────────────────────────────────

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

	// ── Git Integration ──────────────────────────────────────────────

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

	// ── Sidecar Persistence ──────────────────────────────────────────

	private static appendToLedger(record: AgentTraceRecord, cwd: string): void {
		const tracePath = path.join(cwd, TRACE_FILE)
		const traceDir = path.dirname(tracePath)

		if (!fs.existsSync(traceDir)) {
			fs.mkdirSync(traceDir, { recursive: true })
		}

		fs.appendFileSync(tracePath, JSON.stringify(record) + "\n", "utf-8")
	}

	// ── Feedback Generation ──────────────────────────────────────────

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

	// ── Utilities ────────────────────────────────────────────────────

	/** Normalize file path: backslashes → forward, strip leading ./ */
	private static normalizeFilePath(filePath: string): string {
		const normalized = filePath.replaceAll("\\", "/")
		return normalized.startsWith("./") ? normalized.substring(2) : normalized
	}

	/** Read file content, or empty string if not found. */
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
