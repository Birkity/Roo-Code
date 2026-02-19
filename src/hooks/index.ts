/**
 * index.ts — Public API for the Hook Engine module
 *
 * Re-exports all hook components for clean imports:
 *   import { HookEngine, CommandClassifier, TraceLogger } from "../hooks"
 *
 * Phase 1: HookEngine, IntentContextLoader, GatekeeperHook
 * Phase 2: CommandClassifier, AuthorizationGate, AutonomousRecovery,
 *          ScopeEnforcer, PostToolHook
 * Phase 3: HashUtils, SemanticClassifier, TraceLogger
 * Phase 4: OptimisticLockManager, AstPatchValidator, LessonRecorder,
 *          ContextCompactor, SupervisorOrchestrator
 *
 * @see HookEngine.ts — main orchestrator
 * @see IntentContextLoader.ts — select_active_intent handler
 * @see PreToolHook.ts — gatekeeper validation
 * @see CommandClassifier.ts — risk tier classification
 * @see AuthorizationGate.ts — HITL modal dialog
 * @see AutonomousRecovery.ts — structured rejection errors
 * @see ScopeEnforcer.ts — owned scope validation
 * @see PostToolHook.ts — post-edit formatting/linting
 * @see HashUtils.ts — SHA-256 content hashing
 * @see SemanticClassifier.ts — AST_REFACTOR vs INTENT_EVOLUTION
 * @see TraceLogger.ts — Agent Trace serialization & persistence
 * @see OptimisticLock.ts — concurrency control via hash-based locking
 * @see AstPatchValidator.ts — AST-aware patch enforcement
 * @see LessonRecorder.ts — lessons learned persistence to CLAUDE.md
 * @see ContextCompactor.ts — context compaction for sub-agents
 * @see SupervisorOrchestrator.ts — hierarchical orchestration
 * @see types.ts — shared types and constants
 */

// ── Phase 1 ──────────────────────────────────────────────────────────────
export { HookEngine } from "./HookEngine"
export { IntentContextLoader } from "./IntentContextLoader"
export { GatekeeperHook } from "./PreToolHook"

// ── Phase 2 ──────────────────────────────────────────────────────────────
export { CommandClassifier, RiskTier } from "./CommandClassifier"
export type { ClassificationResult } from "./CommandClassifier"

export { AuthorizationGate, AuthorizationDecision } from "./AuthorizationGate"
export type { AuthorizationResult } from "./AuthorizationGate"

export { AutonomousRecovery } from "./AutonomousRecovery"
export type { RecoveryError } from "./AutonomousRecovery"

export { ScopeEnforcer } from "./ScopeEnforcer"
export type { ScopeCheckResult } from "./ScopeEnforcer"

export { PostToolHook } from "./PostToolHook"
export type { PostHookResult } from "./PostToolHook"

// ── Phase 3 ──────────────────────────────────────────────────────────────
export { HashUtils } from "./HashUtils"
export type { HashResult, HashOptions } from "./HashUtils"

export { SemanticClassifier, MutationClass } from "./SemanticClassifier"
export type { MutationClassification, ClassificationSignals } from "./SemanticClassifier"

export { TraceLogger } from "./TraceLogger"
export type {
	AgentTraceRecord,
	TracedFile,
	TraceConversation,
	TraceContributor,
	TraceRange,
	TraceRelated,
	MutationMetadata,
	TraceInput,
	TraceResult,
} from "./TraceLogger"

// ── Phase 4 ──────────────────────────────────────────────────────────────
export { OptimisticLockManager } from "./OptimisticLock"
export type { FileHashSnapshot, LockValidationResult } from "./OptimisticLock"

export { AstPatchValidator, PatchType } from "./AstPatchValidator"
export type { PatchValidationResult, PatchTarget, DiffHunk } from "./AstPatchValidator"

export { LessonRecorder, LessonCategory } from "./LessonRecorder"
export type { LessonEntry, LessonResult } from "./LessonRecorder"

export { ContextCompactor } from "./ContextCompactor"
export type { ConversationTurn, CompactionConfig, CompactionResult, SubAgentContext } from "./ContextCompactor"

export { SupervisorOrchestrator, AgentRole, SubTaskStatus } from "./SupervisorOrchestrator"
export type { SubTask, SubTaskCompletionPayload, OrchestrationState } from "./SupervisorOrchestrator"

// ── Shared Types ─────────────────────────────────────────────────────────
export type { HookContext, PreHookResult, IntentEntry, ActiveIntentsFile } from "./types"
export { MUTATING_TOOLS, EXEMPT_TOOLS } from "./types"
