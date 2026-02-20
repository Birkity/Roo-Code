/** Public API for the Hook Engine module. */

export { HookEngine } from "./HookEngine"
export { IntentContextLoader } from "./IntentContextLoader"
export { GatekeeperHook } from "./PreToolHook"

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

export { SpecifyParser } from "./SpecifyParser"
export type { SpecRequirement } from "./SpecifyParser"

export { OptimisticLockManager } from "./OptimisticLock"
export type { FileHashSnapshot, LockValidationResult } from "./OptimisticLock"

export { AstPatchValidator, PatchType } from "./AstPatchValidator"
export type { PatchValidationResult, PatchTarget, DiffHunk } from "./AstPatchValidator"

export { LessonRecorder, LessonCategory } from "./LessonRecorder"
export type { LessonEntry, LessonResult } from "./LessonRecorder"

export { IntentMapWriter } from "./IntentMapWriter"
export type { IntentMap, IntentMapSection, IntentMapFileEntry, IntentMapUpdateResult } from "./IntentMapWriter"

export { ContextCompactor } from "./ContextCompactor"
export type { ConversationTurn, CompactionConfig, CompactionResult, SubAgentContext } from "./ContextCompactor"

export { SupervisorOrchestrator, AgentRole, SubTaskStatus } from "./SupervisorOrchestrator"
export type { SubTask, SubTaskCompletionPayload, OrchestrationState } from "./SupervisorOrchestrator"

export type { HookContext, PreHookResult, IntentEntry, ActiveIntentsFile } from "./types"
export { MUTATING_TOOLS, EXEMPT_TOOLS } from "./types"
