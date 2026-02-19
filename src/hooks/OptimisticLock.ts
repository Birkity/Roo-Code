/**
 * OptimisticLock.ts — Phase 4: Concurrency Control via Hash-Based Optimistic Locking
 *
 * Implements the "Stale File" detection mechanism for multi-agent environments.
 * Before allowing a file write, the system:
 *
 *   1. Computes the current content_hash of the file on disk.
 *   2. Compares it against the hash recorded when the agent started its turn.
 *   3. If they differ → another agent (or human) modified the file →
 *      BLOCK the write to prevent overwriting.
 *
 * This is "Optimistic" locking because no exclusive locks are held. Instead,
 * conflicts are detected at write-time via hash comparison, which is
 * non-blocking for concurrent readers.
 *
 * Architecture:
 *
 *   ┌────────────────────┐
 *   │ Agent reads file   │──── captureReadHash(path) ──── store hash in registry
 *   └────────────────────┘
 *            │
 *            ▼
 *   ┌────────────────────┐
 *   │ Agent writes file  │──── validateWrite(path)   ──── re-hash disk content
 *   └────────────────────┘
 *            │
 *      ┌─────┴─────┐
 *      │ Hash      │ Hash
 *      │ matches   │ differs
 *      ▼           ▼
 *    ALLOW       BLOCK ("Stale File" error)
 *
 * @see HookEngine.ts — integrates this as a Phase 4 pre-write check
 * @see HashUtils.ts — SHA-256 content hashing
 * @see TRP1 Challenge Week 1, Phase 4: Parallel Orchestration
 * @see Research Paper: Optimistic Locking via Hash Validation
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { HashUtils } from "./HashUtils"

// ── Types ────────────────────────────────────────────────────────────────

/**
 * A snapshot of a file's content hash at the time the agent first read it.
 * Used as the baseline for optimistic lock validation.
 */
export interface FileHashSnapshot {
	/** Relative path from workspace root (forward-slashed) */
	relativePath: string

	/** SHA-256 content hash at read-time (e.g., "sha256:a8f5f167...") */
	hash: string

	/** ISO timestamp when the hash was captured */
	capturedAt: string

	/** The agent/session that captured this hash */
	agentId?: string
}

/**
 * Result of an optimistic lock validation.
 */
export interface LockValidationResult {
	/** Whether the write is permitted */
	allowed: boolean

	/** Human-readable reason for the decision */
	reason: string

	/** The hash at read-time (baseline) */
	baselineHash: string | null

	/** The hash at write-time (current disk state) */
	currentHash: string | null

	/** Whether a conflict was detected */
	conflict: boolean
}

// ── Constants ────────────────────────────────────────────────────────────

/** Maximum number of hash snapshots to keep per file (ring buffer) */
const MAX_SNAPSHOTS_PER_FILE = 10

// ── OptimisticLockManager ────────────────────────────────────────────────

/**
 * Manages optimistic lock state for concurrent file access.
 *
 * This class maintains an in-memory registry of file content hashes
 * captured at read-time. At write-time, it re-hashes the file on disk
 * and compares to detect concurrent modifications.
 *
 * Each HookEngine instance holds its own OptimisticLockManager, scoped
 * to the workspace root (cwd).
 */
export class OptimisticLockManager {
	/**
	 * Registry of file hash snapshots.
	 * Key = normalized relative path, Value = stack of snapshots (latest first).
	 */
	private readonly _registry: Map<string, FileHashSnapshot[]> = new Map()

	/** Workspace root path */
	private readonly cwd: string

	/** Cumulative conflict counter (for telemetry / monitoring) */
	private _conflictCount = 0

	constructor(cwd: string) {
		this.cwd = cwd
	}

	// ── Public API ───────────────────────────────────────────────────

	/**
	 * Capture and store the content hash of a file before the agent operates.
	 *
	 * Called by HookEngine during pre-hook phase for read-only and write tools
	 * to establish the "baseline" hash for later comparison.
	 *
	 * @param relativePath - File path relative to workspace root
	 * @param agentId      - Optional agent/session identifier
	 * @returns The captured FileHashSnapshot, or null if file doesn't exist
	 */
	captureReadHash(relativePath: string, agentId?: string): FileHashSnapshot | null {
		const normalizedPath = OptimisticLockManager.normalizePath(relativePath)
		const absolutePath = path.join(this.cwd, normalizedPath)

		if (!fs.existsSync(absolutePath)) {
			return null
		}

		try {
			const content = fs.readFileSync(absolutePath, "utf-8")
			const hash = HashUtils.hashFile(content)

			const snapshot: FileHashSnapshot = {
				relativePath: normalizedPath,
				hash,
				capturedAt: new Date().toISOString(),
				agentId,
			}

			// Store in the registry (ring buffer per file)
			const existing = this._registry.get(normalizedPath) ?? []
			existing.unshift(snapshot) // newest first
			if (existing.length > MAX_SNAPSHOTS_PER_FILE) {
				existing.pop()
			}
			this._registry.set(normalizedPath, existing)

			return snapshot
		} catch (error) {
			console.warn(
				`[OptimisticLock] Failed to capture hash for ${normalizedPath}: ${error instanceof Error ? error.message : error}`,
			)
			return null
		}
	}

	/**
	 * Validate that a file has not been modified since the agent last read it.
	 *
	 * This is the core optimistic locking check, called by HookEngine
	 * in the pre-hook pipeline before allowing a file write.
	 *
	 * @param relativePath - File path relative to workspace root
	 * @param agentId      - Optional agent id to match the specific snapshot
	 * @returns LockValidationResult indicating whether the write is permitted
	 */
	validateWrite(relativePath: string, agentId?: string): LockValidationResult {
		const normalizedPath = OptimisticLockManager.normalizePath(relativePath)
		const absolutePath = path.join(this.cwd, normalizedPath)

		// If no baseline hash was captured, allow the write but warn
		const snapshots = this._registry.get(normalizedPath)
		if (!snapshots || snapshots.length === 0) {
			return {
				allowed: true,
				reason: `No baseline hash recorded for ${normalizedPath}. Write allowed (first-write scenario).`,
				baselineHash: null,
				currentHash: null,
				conflict: false,
			}
		}

		// Find the matching snapshot (by agent ID if provided, otherwise latest)
		const baseline = agentId ? (snapshots.find((s) => s.agentId === agentId) ?? snapshots[0]) : snapshots[0]

		// If file was deleted externally, that's a conflict
		if (!fs.existsSync(absolutePath)) {
			this._conflictCount++
			return {
				allowed: false,
				reason:
					`STALE FILE: ${normalizedPath} was deleted since agent read it at ${baseline.capturedAt}. ` +
					`The file no longer exists on disk. Re-read the workspace state before proceeding.`,
				baselineHash: baseline.hash,
				currentHash: null,
				conflict: true,
			}
		}

		// Read current disk content and compute hash
		let currentHash: string
		try {
			const currentContent = fs.readFileSync(absolutePath, "utf-8")
			currentHash = HashUtils.hashFile(currentContent)
		} catch (error) {
			// Can't read the file — fail closed (block the write)
			this._conflictCount++
			return {
				allowed: false,
				reason: `LOCK ERROR: Cannot read ${normalizedPath} to verify content hash: ${error instanceof Error ? error.message : error}`,
				baselineHash: baseline.hash,
				currentHash: null,
				conflict: true,
			}
		}

		// The core comparison: baseline hash vs current disk hash
		if (baseline.hash === currentHash) {
			return {
				allowed: true,
				reason: `Lock validation passed: ${normalizedPath} unchanged since read at ${baseline.capturedAt}.`,
				baselineHash: baseline.hash,
				currentHash,
				conflict: false,
			}
		}

		// CONFLICT DETECTED — another agent or human modified the file
		this._conflictCount++
		return {
			allowed: false,
			reason:
				`STALE FILE: ${normalizedPath} has been modified by another agent or human since you read it ` +
				`at ${baseline.capturedAt}. Your baseline hash=${baseline.hash.substring(0, 20)}... ` +
				`but current disk hash=${currentHash.substring(0, 20)}... — these differ. ` +
				`BLOCK: You must re-read the file to get the latest content before writing.`,
			baselineHash: baseline.hash,
			currentHash,
			conflict: true,
		}
	}

	/**
	 * Update the baseline hash after a successful write.
	 *
	 * Called by the post-hook after the write operation succeeds,
	 * so the next write validation uses the new content as baseline.
	 *
	 * @param relativePath - File path relative to workspace root
	 * @param agentId      - Optional agent identifier
	 */
	updateAfterWrite(relativePath: string, agentId?: string): FileHashSnapshot | null {
		// Remove old snapshots and capture new baseline
		const normalizedPath = OptimisticLockManager.normalizePath(relativePath)
		this._registry.delete(normalizedPath)
		return this.captureReadHash(normalizedPath, agentId)
	}

	/**
	 * Clear all lock state for a file. Used when an agent finishes a task
	 * or when a session resets.
	 */
	clearFile(relativePath: string): void {
		const normalizedPath = OptimisticLockManager.normalizePath(relativePath)
		this._registry.delete(normalizedPath)
	}

	/**
	 * Clear all lock state. Used on session reset.
	 */
	clearAll(): void {
		this._registry.clear()
		this._conflictCount = 0
	}

	/**
	 * Get the number of conflicts detected since construction/last clear.
	 */
	get conflictCount(): number {
		return this._conflictCount
	}

	/**
	 * Get all currently tracked file paths.
	 */
	get trackedFiles(): string[] {
		return Array.from(this._registry.keys())
	}

	/**
	 * Get the latest snapshot for a file (for debugging/inspection).
	 */
	getSnapshot(relativePath: string): FileHashSnapshot | null {
		const normalizedPath = OptimisticLockManager.normalizePath(relativePath)
		const snapshots = this._registry.get(normalizedPath)
		return snapshots?.[0] ?? null
	}

	// ── Formatting ───────────────────────────────────────────────────

	/**
	 * Format a stale-file error as structured XML feedback for the AI agent.
	 *
	 * This follows the pattern used by AutonomousRecovery for consistent
	 * error formatting across the middleware.
	 */
	static formatStaleFileError(
		toolName: string,
		filePath: string,
		result: LockValidationResult,
		activeIntentId: string | null,
	): string {
		return [
			"<concurrency_error>",
			`  <error_type>STALE_FILE</error_type>`,
			`  <tool>${toolName}</tool>`,
			`  <target_file>${filePath}</target_file>`,
			`  <baseline_hash>${result.baselineHash ?? "none"}</baseline_hash>`,
			`  <current_hash>${result.currentHash ?? "deleted"}</current_hash>`,
			`  <active_intent>${activeIntentId ?? "none"}</active_intent>`,
			`  <reason>${result.reason}</reason>`,
			`  <recovery_action>`,
			`    You MUST re-read this file using read_file to get the current content.`,
			`    Then recalculate your edits against the updated content and retry.`,
			`    Do NOT attempt to write the same content again without re-reading first.`,
			`  </recovery_action>`,
			"</concurrency_error>",
		].join("\n")
	}

	// ── Private Helpers ──────────────────────────────────────────────

	/**
	 * Normalize file path for consistent registry keys.
	 * Backslash → forward, strip leading ./ or workspace root.
	 */
	static normalizePath(filePath: string): string {
		let normalized = filePath.replaceAll("\\", "/")
		if (normalized.startsWith("./")) {
			normalized = normalized.substring(2)
		}
		return normalized
	}
}
