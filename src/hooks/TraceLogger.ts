/**
 * TraceLogger.ts — Phase 3: Agent Trace Serialization & Sidecar Persistence
 *
 * The crown jewel of the AI-Native Git Layer. This module:
 *
 *   1. Builds a full Agent Trace JSON record conforming to the Agent Trace
 *      specification (https://agent-trace.dev)
 *   2. Injects the active Requirement ID (from Phase 1 handshake) into
 *      the `related` array — creating the "golden thread" from Intent → Code
 *   3. Computes SHA-256 content hashes for spatial independence (Phase 3)
 *   4. Classifies mutations as AST_REFACTOR or INTENT_EVOLUTION (Phase 3)
 *   5. Appends the trace record to `.orchestration/agent_trace.jsonl`
 *   6. Anchors each record to the current Git commit SHA
 *
 * Agent Trace Schema (per cursor/agent-trace):
 * ```json
 * {
 *   "id": "uuid-v4",
 *   "timestamp": "RFC-3339",
 *   "vcs": { "revision_id": "git_sha" },
 *   "files": [{
 *     "relative_path": "src/auth/middleware.ts",
 *     "conversations": [{
 *       "url": "session_log_id",
 *       "contributor": { "entity_type": "AI", "model_identifier": "..." },
 *       "ranges": [{ "start_line": 1, "end_line": 45, "content_hash": "sha256:..." }],
 *       "related": [{ "type": "specification", "value": "INT-001" }]
 *     }]
 *   }]
 * }
 * ```
 *
 * Architecture:
 *   write_to_file completes
 *         ↓
 *   HookEngine.runPostHooks()
 *         ↓
 *   TraceLogger.recordTrace(...)
 *     ├── HashUtils.hashContent(newContent)  → content_hash
 *     ├── SemanticClassifier.classify(old, new) → mutation_class
 *     ├── simpleGit().revparse("HEAD")      → git SHA
 *     ├── uuid.v4()                         → trace ID
 *     └── fs.appendFileSync(agent_trace.jsonl, JSON)
 *
 * @see HashUtils.ts           — content hashing
 * @see SemanticClassifier.ts  — mutation classification
 * @see HookEngine.ts          — orchestrates post-hook execution
 * @see TRP1 Challenge Week 1, Phase 3 — Trace Serialization
 * @see Research Paper, Phase 3 — Sidecar Persistence
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { v4 as uuidv4 } from "uuid"
import simpleGit from "simple-git"

import { HashUtils } from "./HashUtils"
import { SemanticClassifier, MutationClass } from "./SemanticClassifier"
import type { MutationClassification } from "./SemanticClassifier"

// ── Agent Trace Schema Types ─────────────────────────────────────────────

/**
 * Root-level Agent Trace record per the specification.
 * Each record represents a single tool execution event.
 */
export interface AgentTraceRecord {
	/** Unique identifier for this trace record (UUID v4) */
	id: string

	/** RFC 3339 timestamp of when the trace was recorded */
	timestamp: string

	/** Version Control System metadata */
	vcs: VcsMetadata

	/** Array of files modified in this trace event */
	files: TracedFile[]

	/** Phase 3 extension: mutation classification metadata */
	mutation: MutationMetadata
}

/**
 * VCS metadata anchoring the trace to a specific revision.
 */
export interface VcsMetadata {
	/** The Git commit SHA at the time of the trace */
	revision_id: string
}

/**
 * A single file entry in the trace record.
 */
export interface TracedFile {
	/** Relative path from workspace root (forward slashes) */
	relative_path: string

	/** Conversations (agent sessions) that contributed to this file */
	conversations: TraceConversation[]
}

/**
 * A conversation/session that generated code in the traced file.
 */
export interface TraceConversation {
	/** URL or session identifier linking back to the interaction log */
	url: string

	/** The entity that made the contribution */
	contributor: TraceContributor

	/** Line ranges modified, with content hashes */
	ranges: TraceRange[]

	/** Related specifications, requirements, or external references */
	related: TraceRelated[]
}

/**
 * Attribution metadata for the contributor.
 */
export interface TraceContributor {
	/** Type of entity: "AI", "Human", "Mixed", or "Unknown" */
	entity_type: "AI" | "Human" | "Mixed" | "Unknown"

	/** The specific model identifier (e.g., "anthropic/claude-3-5-sonnet") */
	model_identifier: string
}

/**
 * A specific line range within the file, with its content hash.
 */
export interface TraceRange {
	/** 1-indexed start line of the modified range */
	start_line: number

	/** 1-indexed end line of the modified range (inclusive) */
	end_line: number

	/**
	 * SHA-256 hash of the content in this range.
	 * Prefixed with algorithm: "sha256:abc123..."
	 *
	 * This is the key to SPATIAL INDEPENDENCE — if lines move,
	 * the hash remains valid and can be re-linked.
	 */
	content_hash: string
}

/**
 * A related specification or external reference.
 * This is the "golden thread" linking code to intent.
 */
export interface TraceRelated {
	/** Type of relation (e.g., "specification", "ticket", "prompt") */
	type: string

	/** The reference value (e.g., "INT-001", "REQ-42") */
	value: string
}

/**
 * Phase 3 extension: mutation classification metadata.
 * Not part of the base Agent Trace spec, but required by the TRP1 rubric.
 */
export interface MutationMetadata {
	/** The mutation class: AST_REFACTOR or INTENT_EVOLUTION */
	mutation_class: MutationClass

	/** Composite classification score (0.0 – 1.0) */
	score: number

	/** Human-readable reasoning for the classification */
	reasoning: string
}

// ── TraceLogger Input ────────────────────────────────────────────────────

/**
 * Input parameters for recording a trace event.
 */
export interface TraceInput {
	/** The tool that was executed (e.g., "write_to_file") */
	toolName: string

	/** The tool parameters */
	params: Record<string, unknown>

	/** The relative file path that was modified */
	filePath: string

	/** The file content BEFORE modification (empty string for new files) */
	oldContent: string

	/** The file content AFTER modification */
	newContent: string

	/** The active intent ID from Phase 1 handshake (e.g., "INT-001") */
	activeIntentId: string | null

	/** The AI model identifier (e.g., "anthropic/claude-3-5-sonnet") */
	modelIdentifier?: string

	/** Optional session/conversation URL */
	sessionUrl?: string

	/** Optional agent-provided mutation class override */
	agentMutationClass?: string
}

/**
 * Result from recording a trace.
 */
export interface TraceResult {
	/** Whether the trace was successfully recorded */
	success: boolean

	/** The trace record that was persisted (null on failure) */
	record: AgentTraceRecord | null

	/** The classification result */
	classification: MutationClassification | null

	/** Error message if recording failed */
	error?: string

	/** Feedback message for the AI context */
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
			// 1. Classify the mutation (AST_REFACTOR vs INTENT_EVOLUTION)
			const classification = TraceLogger.classifyMutation(input)

			// 2. Compute content hash for spatial independence
			const hashResult = HashUtils.hashContent(input.newContent)

			// 3. Get the current Git SHA
			const gitSha = await TraceLogger.getGitSha(cwd)

			// 4. Build the trace record
			const record = TraceLogger.buildTraceRecord(input, classification, hashResult.hash, gitSha)

			// 5. Persist to .orchestration/agent_trace.jsonl
			TraceLogger.appendToLedger(record, cwd)

			// 6. Build feedback for the AI context
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

	/**
	 * Classify the mutation using SemanticClassifier.
	 *
	 * If the agent provided an explicit mutation_class in the tool params,
	 * we use it as an override but still compute the auto-classification
	 * for transparency.
	 */
	private static classifyMutation(input: TraceInput): MutationClassification {
		if (input.agentMutationClass) {
			return SemanticClassifier.classifyWithOverride(input.agentMutationClass, input.oldContent, input.newContent)
		}
		return SemanticClassifier.classify(input.oldContent, input.newContent)
	}

	// ── Trace Record Building ────────────────────────────────────────

	/**
	 * Build the complete Agent Trace JSON record.
	 *
	 * Maps Phase 1's intent ID into `related` and Phase 3's content hash
	 * into `ranges` — creating the golden thread: Intent → Code → Hash.
	 */
	private static buildTraceRecord(
		input: TraceInput,
		classification: MutationClassification,
		contentHash: string,
		gitSha: string,
	): AgentTraceRecord {
		// Compute line count for the range
		const lineCount = input.newContent.split("\n").length

		// Build the related array — inject the Requirement ID from Phase 1
		const related: TraceRelated[] = []
		if (input.activeIntentId) {
			related.push({
				type: "specification",
				value: input.activeIntentId,
			})
		}

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

	/**
	 * Get the current Git HEAD SHA.
	 *
	 * Uses simple-git to read the current commit hash. If the repo
	 * is not a git repository or has no commits, returns a placeholder.
	 *
	 * @param cwd - Workspace root path
	 * @returns The current HEAD SHA, or "no-git-sha" if unavailable
	 */
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

	/**
	 * Append a trace record to `.orchestration/agent_trace.jsonl`.
	 *
	 * JSONL format: one JSON object per line, append-only.
	 * This is the "ledger" — the immutable history of every mutating action.
	 *
	 * @param record - The trace record to persist
	 * @param cwd    - Workspace root path
	 */
	private static appendToLedger(record: AgentTraceRecord, cwd: string): void {
		const tracePath = path.join(cwd, TRACE_FILE)
		const traceDir = path.dirname(tracePath)

		// Ensure .orchestration/ directory exists
		if (!fs.existsSync(traceDir)) {
			fs.mkdirSync(traceDir, { recursive: true })
		}

		// Serialize as single-line JSON + newline (JSONL format)
		const jsonLine = JSON.stringify(record) + "\n"

		// Append (creates file if it doesn't exist)
		fs.appendFileSync(tracePath, jsonLine, "utf-8")
	}

	// ── Feedback Generation ──────────────────────────────────────────

	/**
	 * Build feedback for the AI context window.
	 *
	 * This feedback is appended to the tool_result so the agent
	 * is aware of the trace action and can reference the intent ID
	 * in subsequent operations.
	 */
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

	/**
	 * Normalize a file path for the trace record.
	 * Converts backslashes to forward slashes, strips leading ./ or absolute prefix.
	 */
	private static normalizeFilePath(filePath: string): string {
		let normalized = filePath.replaceAll("\\", "/")

		// Strip leading ./
		if (normalized.startsWith("./")) {
			normalized = normalized.substring(2)
		}

		return normalized
	}

	/**
	 * Read the old file content before modification.
	 * Returns empty string if the file doesn't exist (new file creation).
	 *
	 * @param filePath - Relative or absolute file path
	 * @param cwd      - Workspace root path
	 * @returns The file content, or empty string if not found
	 */
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
