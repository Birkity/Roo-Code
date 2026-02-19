# TRP1 Hook System — Intent-Driven Architecture for Roo Code

**TRP1 Challenge Week 1 — Architecting the AI-Native IDE & Intent-Code Traceability**  
_Fork: [Roo Code](https://github.com/Birkity/Roo-Code)_  
_Date: February 2026_

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Phase 0: Archaeological Dig](#phase-0-archaeological-dig)
- [Phase 1: The Handshake (Reasoning Loop)](#phase-1-the-handshake-reasoning-loop)
- [Phase 2: Hook Middleware & Security Boundary](#phase-2-hook-middleware--security-boundary)
- [Phase 3: AI-Native Git Layer (Full Traceability)](#phase-3-ai-native-git-layer-full-traceability)
- [Phase 4: Parallel Orchestration (The Master Thinker)](#phase-4-parallel-orchestration-the-master-thinker)
- [Phase 5: Gap Closure & Hardening](#phase-5-gap-closure--hardening)
- [Directory Structure](#directory-structure)
- [Test Coverage](#test-coverage)
- [Data Model (.orchestration/)](#data-model-orchestration)
- [How to Run Tests](#how-to-run-tests)
- [Execution Flow Diagrams](#execution-flow-diagrams)

---

## Overview

This project transforms Roo Code from a standard AI coding assistant into a **governed AI-Native IDE** with deterministic intent-code traceability. The hook system intercepts every tool call at two lifecycle phases:

1. **PreToolUse** — Before execution: validates intent, classifies risk, enforces scope, checks concurrency, validates patches, requests human approval
2. **PostToolUse** — After execution: auto-formats code, runs linting, records agent traces, persists lessons, updates lock state

The system enforces a **Two-Stage State Machine** for every conversation turn:

- **Stage 1**: Agent analyzes the request and calls `select_active_intent(intent_id)` to load business context
- **Stage 2**: Agent operates within declared scope, with all actions traced back to the originating intent

**Key Metrics:**

- 19 source files in `src/hooks/`
- 270 tests across 13 test suites
- 5 implementation phases (0–5)
- Full middleware pipeline: Gatekeeper → Context Loader → Classifier → Scope → Lock → AST Patch → AuthZ

---

## Architecture

```
┌────────────────┐     ┌──────────────────────────────────────┐     ┌──────────────┐
│ AI Model       │────▷│ HookEngine — PreToolUse              │────▷│ Tool Handler │
│ (tool_use)     │     │  1. Gatekeeper (intent check)        │     │ .handle()    │
└────────────────┘     │  2. IntentContextLoader              │     └──────────────┘
                       │  3. CommandClassifier                 │            │
                       │  4. ScopeEnforcer                     │            ▼
                       │  5. OptimisticLock (stale file check) │     ┌──────────────┐
                       │  6. AstPatchValidator (rewrite check) │     │ PostToolUse  │
                       │  7. AuthorizationGate (HITL)          │     │  1. Prettier  │
                       └──────────────────────────────────────┘     │  2. ESLint    │
                                                                    │  3. Trace     │
                              ┌────────────────┐                    │  4. Lesson    │
                              │ On Rejection:  │                    │  5. Lock upd  │
                              │ Autonomous     │                    └──────────────┘
                              │ Recovery       │
                              └────────────────┘
```

**Design Principles:**

- **Composable** — Hooks are registered as ordered arrays; new hooks plug in without modifying existing ones
- **Non-intrusive** — The engine wraps existing tool execution; it does not replace tool handlers
- **Fail-safe** — If a hook throws, the error is captured and returned as a `tool_result` error

---

## Phase 0: Archaeological Dig

**Goal:** Map the nervous system of Roo Code before injecting any hooks.

### Findings

| Component             | Location                                                | Notes                                         |
| --------------------- | ------------------------------------------------------- | --------------------------------------------- |
| Tool dispatch loop    | `src/core/assistant-message/presentAssistantMessage.ts` | Main `switch` statement — primary hook target |
| Tool handlers         | `src/core/tools/*.ts`                                   | Individual `.handle()` methods                |
| System prompt builder | `src/core/prompts/system.ts`                            | Inject intent rules here                      |
| Webview ↔ Host IPC   | `src/core/webview/webviewMessageHandler.ts`             | Add intent selection messages                 |
| Task management       | `src/core/task/Task.ts`                                 | Extend with intent metadata                   |

### Key Observations

- Roo Code already has approval gates (`askApproval`) — ideal for HITL enforcement
- Event-driven design (EventEmitter) — natural fit for HookEngine
- Strong type system (`@roo-code/types`) — extensible for `IntentMetadata`
- Existing persistence in `.roo/tasks/{taskId}/` — extended to `.orchestration/`

**Deliverable:** [ARCHITECTURE_NOTES.md](ARCHITECTURE_NOTES.md)

---

## Phase 1: The Handshake (Reasoning Loop)

**Goal:** Solve the Context Paradox — force the AI to declare a business intent before writing any code.

### Components

| File                     | Purpose                                                | Lines |
| ------------------------ | ------------------------------------------------------ | ----- |
| `HookEngine.ts`          | Central middleware orchestrator                        | ~780  |
| `IntentContextLoader.ts` | Pre-hook: handles `select_active_intent`               | ~230  |
| `PreToolHook.ts`         | Gatekeeper: blocks mutating tools without intent       | ~120  |
| `types.ts`               | Shared types (HookContext, PreHookResult, IntentEntry) | ~80   |

### 1.1 New Tool: `select_active_intent`

Registered across the full Roo Code tool pipeline:

| File Modified                                                 | Change                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/types/src/tool.ts`                                  | Added `"select_active_intent"` to canonical `toolNames` |
| `src/shared/tools.ts`                                         | Added interface, param `intent_id`, ALWAYS_AVAILABLE    |
| `src/core/prompts/tools/native-tools/select_active_intent.ts` | JSON Schema for LLM tool calling                        |
| `src/core/prompts/tools/native-tools/index.ts`                | Registered in `getNativeTools()`                        |

### 1.2 HookEngine (`HookEngine.ts`)

The central orchestrator that manages all pre-hooks and post-hooks. Instantiated per task:

```typescript
// Task.ts constructor
this.hookEngine = new HookEngine(this.cwd)
```

Integration point in `presentAssistantMessage.ts`:

```typescript
if (!block.partial) {
  const hookResult = await cline.hookEngine.runPreHooks(block.name, block.nativeArgs ?? block.params ?? {})
  if (hookResult.action === "block" || hookResult.action === "inject") {
    pushToolResult(hookResult.action === "block"
      ? formatResponse.toolError(hookResult.toolResult)
      : hookResult.toolResult)
    break
  }
}
switch (block.name) { ... }  // Only reached if hooks allow
```

### 1.3 Gatekeeper (`PreToolHook.ts`)

Decision tree:

```
Is tool exempt? (read_file, select_active_intent, etc.)
  → YES → Allow
  → NO → Is intent active?
           → YES → Allow
           → NO → BLOCK: "You must cite a valid active Intent ID."
```

Tool classification:

| Category      | Tools                                                    | Intent Required? |
| ------------- | -------------------------------------------------------- | ---------------- |
| **Mutating**  | `write_to_file`, `apply_diff`, `edit`, `execute_command` | YES              |
| **Read-only** | `read_file`, `list_files`, `search_files`                | NO               |
| **Meta**      | `ask_followup_question`, `attempt_completion`            | NO               |
| **Handshake** | `select_active_intent`                                   | NO (exempt)      |

### 1.4 IntentContextLoader (`IntentContextLoader.ts`)

Execution flow:

1. Intercepts `select_active_intent` tool calls only
2. Reads `.orchestration/active_intents.yaml`
3. Finds matching intent by ID
4. Falls back to `.specify/` markdown files if not found in YAML (Phase 5)
5. Builds `<intent_context>` XML block
6. Returns XML as `tool_result` → AI sees it in next turn

Example XML output:

```xml
<intent_context>
  <intent id="INT-001" name="JWT Auth Migration" status="IN_PROGRESS">
    <constraints>
      <constraint>Must not use external auth providers</constraint>
    </constraints>
    <owned_scope>
      <path>src/auth/**</path>
    </owned_scope>
    <acceptance_criteria>
      <criterion>Unit tests in tests/auth/ pass</criterion>
    </acceptance_criteria>
  </intent>
  <instruction>
    You are now operating under Intent "INT-001: JWT Auth Migration".
    You MUST respect all constraints. You may ONLY modify files matching owned_scope.
  </instruction>
</intent_context>
```

### 1.5 Session State Management

The HookEngine manages session lifecycle for cross-session continuity:

- **`startSession()`** — Called automatically in constructor; reads `.orchestration/TASKS.md` to restore prior session state
- **`endSession(summary?)`** — Writes session timestamps, active intent, `.specify/` requirements summary to TASKS.md
- **`getSessionContext()`** — Returns prior session's state for continuity

### 1.6 System Prompt Injection

A new prompt section in `src/core/prompts/sections/intent-protocol.ts` enforces:

> "You are an Intent-Driven Architect. You CANNOT write code or call any mutating tool immediately. Your first action MUST be to call `select_active_intent(intent_id)`."

This provides **probabilistic enforcement** (LLM follows instructions) while the Gatekeeper provides **deterministic enforcement** (runtime blocking).

---

## Phase 2: Hook Middleware & Security Boundary

**Goal:** Architect the security boundary with risk classification, human approval, scope enforcement, and post-edit quality automation.

### Components

| File                    | Purpose                                                         | Lines |
| ----------------------- | --------------------------------------------------------------- | ----- |
| `CommandClassifier.ts`  | Risk-tier classification (SAFE / DESTRUCTIVE / CRITICAL / META) | ~228  |
| `AuthorizationGate.ts`  | UI-blocking HITL modal for risky operations                     | ~260  |
| `ScopeEnforcer.ts`      | Glob-based owned-scope enforcement                              | ~206  |
| `PostToolHook.ts`       | Post-edit Prettier + ESLint auto-formatting                     | ~310  |
| `AutonomousRecovery.ts` | Self-correction error formatting on rejection                   | ~229  |

### 2.1 Command Classification (`CommandClassifier.ts`)

Four risk tiers:

| Tier            | Description                 | Examples                                         |
| --------------- | --------------------------- | ------------------------------------------------ |
| **SAFE**        | Read-only operations        | `read_file`, `list_files`, `search_files`        |
| **DESTRUCTIVE** | Write/delete operations     | `write_to_file`, `apply_diff`, `execute_command` |
| **CRITICAL**    | High-risk terminal commands | `rm -rf`, `git push --force`, `DROP TABLE`       |
| **META**        | Conversation control        | `ask_followup_question`, `attempt_completion`    |

Uses static tool-name mapping plus regex pattern matching for `execute_command` payloads (e.g., `rm -rf`, `curl | bash`, `chmod 777`).

### 2.2 Authorization Gate (`AuthorizationGate.ts`)

HITL (Human-in-the-Loop) boundary:

1. **SAFE/META** → auto-approved
2. **DESTRUCTIVE** → VS Code warning modal (Approve / Reject)
3. **CRITICAL** → VS Code warning modal showing the matched dangerous pattern
4. `.intentignore` support for bypassing checks on trusted intents

The Promise chain is **paused indefinitely** until the user clicks Approve or Reject — the impenetrable defense against runaway execution loops.

### 2.3 Scope Enforcement (`ScopeEnforcer.ts`)

Validates file-write targets against the active intent's `owned_scope` glob patterns:

```
Target: src/billing/invoice.ts
Scope:  ["src/auth/**", "src/middleware/jwt.ts"]
Result: BLOCKED — "Scope Violation: INT-001 is not authorized to edit src/billing/invoice.ts"
```

Uses the `picomatch` algorithm for glob matching. Supports `**`, `*`, exact paths, and nested patterns.

### 2.4 Post-Edit Automation (`PostToolHook.ts`)

Fires AFTER a tool successfully executes:

1. Detects the modified file path from tool params
2. Runs **Prettier** on the file (auto-format)
3. Runs **ESLint** on the file (lint check)
4. If errors → appends feedback to the next `tool_result` for self-correction
5. If clean → logs success

### 2.5 Autonomous Recovery (`AutonomousRecovery.ts`)

When AuthorizationGate rejects an operation, formats a standardized JSON error so the LLM can self-correct:

```json
{
	"error_type": "AUTHORIZATION_REJECTED",
	"tool": "write_to_file",
	"intent_id": "INT-001",
	"reason": "Operation rejected by human reviewer",
	"recovery_guidance": ["Acknowledge the rejection", "Analyze the violated constraint", "Propose a safe alternative"]
}
```

---

## Phase 3: AI-Native Git Layer (Full Traceability)

**Goal:** Implement the "golden thread" linking every code change back to its originating requirement via content hashing, semantic classification, and agent trace records.

### Components

| File                    | Purpose                                            | Lines |
| ----------------------- | -------------------------------------------------- | ----- |
| `HashUtils.ts`          | SHA-256 content hashing with normalization         | ~180  |
| `SemanticClassifier.ts` | Weighted scoring: AST_REFACTOR vs INTENT_EVOLUTION | ~315  |
| `TraceLogger.ts`        | Agent Trace record builder + JSONL persistence     | ~288  |
| `SpecifyParser.ts`      | `.specify/` markdown intent extraction (Phase 5)   | ~260  |

### 3.1 Content Hashing (`HashUtils.ts`)

```typescript
hashFile(content) // SHA-256 of normalized file content
hashRange(content, startLine, endLine) // Hash a specific line range (spatial independence)
verify(content, hash) // Check content against a stored hash
normalizeContent(content) // CRLF→LF, trim trailing whitespace
```

All hashes are prefixed with `sha256:` for forward-compatible algorithm identification.

**Spatial Independence**: If lines move (e.g., due to a refactor adding lines above), `hashRange()` ensures the content block's identity is preserved via its hash — not its line numbers.

### 3.2 Semantic Classification (`SemanticClassifier.ts`)

Mathematical scoring model:

$$\text{Score} = w_1 \cdot \Delta\text{Imports} + w_2 \cdot \Delta\text{Exports} + w_3 \cdot \Delta\text{Signatures} + w_4 \cdot \Delta\text{LineCount} + w_5 \cdot \text{NewSymbols}$$

| Score     | Classification     | Meaning                                                |
| --------- | ------------------ | ------------------------------------------------------ |
| `>= 0.35` | `INTENT_EVOLUTION` | New feature or behavior change                         |
| `< 0.35`  | `AST_REFACTOR`     | Intent-preserving refactor (rename, extract, reformat) |

Also supports `classifyWithOverride()` for agent-provided classification with agreement/disagreement tracking.

### 3.3 Agent Trace Logger (`TraceLogger.ts`)

Builds Agent Trace records per the agent-trace.dev specification:

1. Captures `vcs.revision_id` from current Git SHA
2. Computes before/after content hashes
3. Injects the active Requirement ID into the `related` field — **the "golden thread"**
4. Classifies the mutation via SemanticClassifier
5. Appends the record to `.orchestration/agent_trace.jsonl`

Example trace record:

```json
{
	"id": "uuid-v4",
	"timestamp": "2026-02-18T12:00:00Z",
	"vcs": { "revision_id": "abc123" },
	"files": [
		{
			"relative_path": "src/auth/middleware.ts",
			"conversations": [
				{
					"contributor": { "entity_type": "AI", "model_identifier": "claude-sonnet" },
					"ranges": [
						{
							"start_line": 15,
							"end_line": 45,
							"content_hash": "sha256:a8f5f167f44f..."
						}
					],
					"related": [{ "type": "specification", "value": "INT-001" }]
				}
			]
		}
	],
	"mutation": { "class": "INTENT_EVOLUTION", "score": 0.72 }
}
```

### 3.4 Tool Schema Modifications

`write_to_file` tool definition updated with two required traceability parameters:

| Parameter        | Type                                   | Description                             |
| ---------------- | -------------------------------------- | --------------------------------------- |
| `intent_id`      | `string`                               | Active Intent ID authorizing this write |
| `mutation_class` | `"AST_REFACTOR" \| "INTENT_EVOLUTION"` | Semantic classification of the change   |

---

## Phase 4: Parallel Orchestration (The Master Thinker)

**Goal:** Manage Silicon Workers with optimistic locking, AST-aware patching, context compaction, hierarchical sub-agent orchestration, and persistent lesson recording.

### Components

| File                        | Purpose                                          | Pattern                   |
| --------------------------- | ------------------------------------------------ | ------------------------- |
| `OptimisticLock.ts`         | Hash-based concurrency control                   | Stateful (per HookEngine) |
| `AstPatchValidator.ts`      | Block full-file rewrites, enforce targeted diffs | Static utility            |
| `LessonRecorder.ts`         | Persist lessons to CLAUDE.md shared brain        | Static utility            |
| `ContextCompactor.ts`       | Prevent context rot via summarization            | Static utility            |
| `SupervisorOrchestrator.ts` | Hierarchical sub-agent orchestration             | Stateful                  |

### 4.1 Optimistic Locking (`OptimisticLock.ts`)

Concurrency control algorithm:

1. **Read phase**: `captureReadHash(path)` stores SHA-256 baseline of file content
2. **Write phase**: `validateWrite(path)` re-hashes disk content to detect external changes
3. **If baseline ≠ current**: **BLOCK** with `STALE_FILE` error — a parallel agent modified the file
4. **On success**: `updateAfterWrite(path)` refreshes the baseline

Key features:

- Ring buffer of 10 snapshots per file (multi-agent stacking)
- Agent-scoped snapshot matching via optional `agentId`
- Non-blocking for concurrent readers (optimistic, not pessimistic)
- Structured XML error feedback via `formatStaleFileError()`

### 4.2 AST-Aware Patch Validation (`AstPatchValidator.ts`)

Forces agents to emit targeted patches instead of full-file rewrites:

| Check                                  | Threshold               | Action                        |
| -------------------------------------- | ----------------------- | ----------------------------- |
| Change ratio > 60% on files ≥ 15 lines | `FULL_REWRITE` detected | **BLOCK** with patch guidance |
| New file (empty old content)           | Always                  | **ALLOW**                     |
| `search_and_replace` tool              | Inherently targeted     | **ALLOW**                     |
| `apply_diff` with valid hunks          | Well-formed diff        | **ALLOW**                     |

Additional capabilities:

- `extractSymbols()` — Regex-based AST symbol detection (functions, classes, interfaces)
- `identifyChangedSymbols()` — Diffs old vs new symbol sets
- `parseUnifiedDiff()` — Validates `@@ -a,b +c,d @@` hunk format
- `patchMcpToolDefinitions()` — Injects enforcement warnings into MCP tool definitions
- `getToolDefinitionOverrides()` — Returns description overrides for system prompt

### 4.3 Lesson Recording (`LessonRecorder.ts`)

Persists "lessons learned" to `CLAUDE.md` — the shared brain file:

| Trigger               | Method                          | Records                         |
| --------------------- | ------------------------------- | ------------------------------- |
| Lint failure          | `recordLintFailure()`           | ESLint rule names and file path |
| Test failure          | `recordTestFailure()`           | stderr output                   |
| Scope violation       | `recordScopeViolation()`        | Owned scope boundaries          |
| Lock conflict         | `recordLockConflict()`          | Baseline/current hash mismatch  |
| Architecture decision | `recordArchitecturalDecision()` | Design rationale                |

Auto-creates `CLAUDE.md` with template structure if absent. Auto-prunes to 200 lessons maximum.

### 4.4 Context Compaction (`ContextCompactor.ts`)

Prevents "Context Rot" by summarizing older conversation turns:

```typescript
truncateToolOutput(output, maxLength)  // Preserves head (60%) + tail (20%)
compact(turns, config)                 // Splits into summarized + preserved verbatim
summarizeTurns(turns, maxLength)       // Role-aware bullet summaries
prepareSubAgentContext(...)            // Narrow context for sub-agent spawn
estimateTokens(turns)                  // Heuristic: 4 chars ≈ 1 token
```

Default configuration:

- `maxTokenBudget`: 120,000 tokens
- `maxToolOutputLength`: 3,000 chars
- `preserveRecentTurns`: 6 (verbatim)
- Exports state to `.orchestration/TASKS.md` before compaction

### 4.5 Supervisor Orchestration (`SupervisorOrchestrator.ts`)

Hierarchical Manager → Worker pattern for multi-agent coordination:

**Agent Roles:**

| Role         | Responsibility                        |
| ------------ | ------------------------------------- |
| `ARCHITECT`  | Plans decomposition, owns no code     |
| `BUILDER`    | Implements features in assigned scope |
| `TESTER`     | Writes and runs tests                 |
| `REVIEWER`   | Reviews diffs for quality             |
| `DOCUMENTER` | Updates documentation                 |

**Sub-Task Lifecycle:**

1. `createSubTask(description, role, scope)` → `PENDING`
2. `prepareSubTask(id, parentTurns, intent)` → `IN_PROGRESS` (builds `SubAgentContext`)
3. Sub-agent executes autonomously within assigned scope
4. `completeSubTask(id, payload)` → `COMPLETED` or `FAILED`

**Write Partitioning:**

- `validateScopePartitioning()` — Detects scope overlaps between sub-tasks
- Mathematically eliminates spatial conflicts by assigning disjoint file scopes
- `getExecutionOrder()` — Topological sort with priority-based tie-breaking

**State Persistence:** Saves to `.orchestration/orchestration_state.json` after every mutation.

---

## Phase 5: Gap Closure & Hardening

**Goal:** Close implementation gaps identified during curriculum audit, ensuring all requirements from both TRP1 curricula are fully satisfied.

### 5.1 Session State Management (Gap: Phase 1.4)

**Problem:** No read of TASKS.md at session start, no write at session end.

**Solution:** Added `startSession()`, `endSession()`, `getSessionContext()` to HookEngine:

- Constructor auto-calls `startSession()` to read `.orchestration/TASKS.md`
- `endSession(summary?)` writes session timestamps, active intent, `.specify/` requirements summary
- `getSessionContext()` returns prior session's state for cross-session continuity

### 5.2 `.specify/` Markdown Intent Extraction (Gap: Phase 3.1)

**Problem:** IntentContextLoader only reads `active_intents.yaml`; no support for `.specify/` markdown files.

**Solution:** Created `SpecifyParser.ts` — a new module that scans `.specify/` directory for markdown requirement specs:

Three extraction strategies (in priority order):

1. **YAML frontmatter:** `id: REQ-001` in `---` delimited block
2. **Markdown heading:** `# REQ-001: Feature Name`
3. **Inline pattern:** `Requirement ID: REQ-001`

Parses structured sections: Constraints, Owned Scope, Acceptance Criteria.

IntentContextLoader now falls back to `.specify/` when the YAML lookup fails, enabling SpecKit-style markdown specifications alongside YAML intents.

```typescript
// IntentContextLoader.ts — fallback chain
const matchingIntent = intents.active_intents.find((i) => i.id === intentId)
if (!matchingIntent) {
	const specReq = SpecifyParser.findRequirement(ctx.cwd, intentId)
	if (specReq) {
		const specIntent = SpecifyParser.toIntentEntry(specReq)
		// ... inject context from .specify/ requirement
	}
}
```

### 5.3 MCP Tool Definition Interception (Gap: Phase 4.4)

**Problem:** AstPatchValidator enforces at runtime but doesn't modify tool definitions to warn agents proactively.

**Solution:** Added two static methods to AstPatchValidator:

- `patchMcpToolDefinitions(tools)` — Patches write-type tool descriptions with enforcement warnings
- `getToolDefinitionOverrides()` — Returns description overrides for system prompt integration

Updated `write_to_file.ts` description:

> **⚠️ AST-Aware Patch Enforcement:** Full-file rewrites on existing files with more than 15 lines are BLOCKED by the AST-Aware Patch Validator. For existing files, use `apply_diff` or `search_and_replace` for targeted edits instead.

---

## Directory Structure

```
src/hooks/
├── index.ts                    # Public API (all exports)
├── types.ts                    # Shared types & constants
│
├── HookEngine.ts               # Phase 1+: Central middleware orchestrator
├── IntentContextLoader.ts      # Phase 1: select_active_intent handler
├── PreToolHook.ts              # Phase 1: Gatekeeper (blocks without intent)
│
├── CommandClassifier.ts        # Phase 2: Risk tier classification
├── AuthorizationGate.ts        # Phase 2: HITL modal dialog
├── ScopeEnforcer.ts            # Phase 2: Owned scope enforcement
├── PostToolHook.ts             # Phase 2: Prettier + ESLint automation
├── AutonomousRecovery.ts       # Phase 2: Structured rejection errors
│
├── HashUtils.ts                # Phase 3: SHA-256 content hashing
├── SemanticClassifier.ts       # Phase 3: AST_REFACTOR vs INTENT_EVOLUTION
├── TraceLogger.ts              # Phase 3: Agent Trace JSONL persistence
├── SpecifyParser.ts            # Phase 3/5: .specify/ markdown parser
│
├── OptimisticLock.ts           # Phase 4: Hash-based concurrency control
├── AstPatchValidator.ts        # Phase 4: Full-rewrite detection & blocking
├── LessonRecorder.ts           # Phase 4: CLAUDE.md shared brain
├── ContextCompactor.ts         # Phase 4: Context rot prevention
├── SupervisorOrchestrator.ts   # Phase 4: Hierarchical sub-agent management
│
└── __tests__/
    ├── AstPatchValidator.test.ts       # 31 tests
    ├── AutonomousRecovery.test.ts      #  7 tests
    ├── CommandClassifier.test.ts       # 36 tests
    ├── ContextCompactor.test.ts        # 25 tests
    ├── HashUtils.test.ts              # 19 tests
    ├── LessonRecorder.test.ts         # 17 tests
    ├── OptimisticLock.test.ts         # 23 tests
    ├── ScopeEnforcer.test.ts          # 16 tests
    ├── SemanticClassifier.test.ts     # 20 tests
    ├── SessionState.test.ts           # 10 tests
    ├── SpecifyParser.test.ts          # 21 tests
    ├── SupervisorOrchestrator.test.ts # 30 tests
    └── TraceLogger.test.ts            # 15 tests
```

---

## Test Coverage

| Phase   | Test File                        | Tests   | Covers                                                 |
| ------- | -------------------------------- | ------- | ------------------------------------------------------ |
| **1**   | `SessionState.test.ts`           | 10      | Session start/end, TASKS.md read/write, round-trip     |
| **2**   | `CommandClassifier.test.ts`      | 36      | Risk tiers, command regex, file write detection        |
| **2**   | `ScopeEnforcer.test.ts`          | 16      | Glob matching, path normalization, scope blocking      |
| **2**   | `AutonomousRecovery.test.ts`     | 7       | Rejection formatting, scope violations, JSON structure |
| **3**   | `HashUtils.test.ts`              | 19      | SHA-256, normalization, range hashing, verification    |
| **3**   | `SemanticClassifier.test.ts`     | 20      | Classification scoring, signals, override tracking     |
| **3**   | `TraceLogger.test.ts`            | 15      | Trace records, golden thread, JSONL persistence        |
| **3/5** | `SpecifyParser.test.ts`          | 21      | Frontmatter/heading/inline extraction, sections        |
| **4**   | `OptimisticLock.test.ts`         | 23      | Hash capture, validation, agent scoping, ring buffer   |
| **4**   | `AstPatchValidator.test.ts`      | 31      | Rewrites, diffs, symbols, MCP tool patching            |
| **4**   | `LessonRecorder.test.ts`         | 17      | Lesson formatting, CLAUDE.md management, categories    |
| **4**   | `ContextCompactor.test.ts`       | 25      | Truncation, tokens, summarization, sub-agent context   |
| **4**   | `SupervisorOrchestrator.test.ts` | 30      | Sub-tasks, scopes, dependencies, state persistence     |
|         | **Total**                        | **270** |                                                        |

---

## Data Model (.orchestration/)

The hook system maintains a sidecar storage pattern:

```
.orchestration/
├── active_intents.yaml       # Intent specifications (YAML)
├── agent_trace.jsonl         # Append-only action ledger
├── orchestration_state.json  # Supervisor sub-task state
├── TASKS.md                  # Session state continuity
└── CLAUDE.md                 # Shared brain (lessons learned)

.specify/                     # Alternative: Markdown-based intents
└── *.md                      # One file per requirement (REQ-XXX)
```

### active_intents.yaml

```yaml
active_intents:
    - id: "INT-001"
      name: "JWT Authentication Migration"
      status: "IN_PROGRESS"
      owned_scope:
          - "src/auth/**"
          - "src/middleware/jwt.ts"
      constraints:
          - "Must not use external auth providers"
      acceptance_criteria:
          - "Unit tests in tests/auth/ pass"
```

### agent_trace.jsonl

Each line is a JSON record linking an agent action to its originating intent via the `related` field (the "golden thread"):

```json
{
	"id": "uuid",
	"timestamp": "...",
	"vcs": { "revision_id": "sha" },
	"files": [
		{
			"relative_path": "...",
			"conversations": [
				{
					"contributor": { "entity_type": "AI" },
					"ranges": [{ "content_hash": "sha256:..." }],
					"related": [{ "type": "specification", "value": "INT-001" }]
				}
			]
		}
	],
	"mutation": { "class": "INTENT_EVOLUTION", "score": 0.72 }
}
```

### .specify/ Markdown

Alternative to YAML. Each `.md` file defines one requirement:

```markdown
---
id: REQ-001
name: User Authentication
status: IN_PROGRESS
---

# User Authentication

## Constraints

- Must use OAuth2 flow

## Owned Scope

- src/auth/\*\*

## Acceptance Criteria

- User can log in with email/password
```

---

## How to Run Tests

```bash
# From the repository root (src/ directory)
cd src
npx vitest run hooks/__tests__/ --reporter=verbose

# Run a specific test file
npx vitest run hooks/__tests__/HookEngine.test.ts --reporter=verbose

# Watch mode
npx vitest watch hooks/__tests__/
```

Expected output: **270 tests passing across 13 test files**.

---

## Execution Flow Diagrams

### Full PreToolUse → PostToolUse Pipeline

```
User Request
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│ PreToolUse Pipeline (HookEngine.runPreHooks)                     │
│                                                                  │
│  ┌─────────────┐  ┌────────────────────┐  ┌──────────────────┐  │
│  │ Phase 1      │  │ Phase 2            │  │ Phase 4          │  │
│  │ Gatekeeper   │─▶│ CommandClassifier  │─▶│ OptimisticLock   │  │
│  │ ContextLoader│  │ ScopeEnforcer      │  │ AstPatchValidator│  │
│  │              │  │ AuthorizationGate  │  │                  │  │
│  └─────────────┘  └────────────────────┘  └──────────────────┘  │
│                                                                  │
│  Any stage can BLOCK → Autonomous Recovery → LLM self-corrects   │
└─────────────────────────────┬────────────────────────────────────┘
                              │ ALLOW
                              ▼
                    ┌──────────────────┐
                    │ Tool Executes    │ (Roo Code tool handler)
                    └────────┬─────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│ PostToolUse Pipeline (HookEngine.runPostHooks)                   │
│                                                                  │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────┐   │
│  │ Phase 2       │  │ Phase 3       │  │ Phase 4            │   │
│  │ Prettier      │  │ TraceLogger   │  │ LessonRecorder     │   │
│  │ ESLint        │  │ HashUtils     │  │ Lock Update        │   │
│  │               │  │ Classifier    │  │                    │   │
│  └──────────────┘  └───────────────┘  └────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### The Handshake Sequence

```
User: "Refactor the auth middleware"
  │
  ▼
LLM: tool_use → select_active_intent("INT-002")
  │
  ▼
HookEngine → Gatekeeper: ALLOW (exempt tool)
           → IntentContextLoader: read YAML → build XML
  │
  ▼
LLM receives: <intent_context> ... constraints, scope, criteria ...
  │
  ▼
LLM: tool_use → write_to_file("src/auth/middleware.ts", ...)
  │
  ▼
HookEngine → Gatekeeper: ALLOW (intent active)
           → CommandClassifier: DESTRUCTIVE
           → ScopeEnforcer: IN_SCOPE ✓
           → OptimisticLock: NO_CONFLICT ✓
           → AstPatchValidator: TARGETED_EDIT ✓
           → AuthorizationGate: [user approves]
  │
  ▼
Tool executes → PostHooks fire (format, trace, lesson)
```

---

## Summary of All Phases

| Phase | Name                   | Goal                                            | Components                                                                                  | Tests          |
| ----- | ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------- |
| **0** | Archaeological Dig     | Map Roo Code internals                          | ARCHITECTURE_NOTES.md                                                                       | —              |
| **1** | The Handshake          | Force intent declaration before code            | HookEngine, Gatekeeper, IntentContextLoader, types.ts                                       | 10             |
| **2** | Security Boundary      | Risk classification + HITL + scope + quality    | CommandClassifier, AuthorizationGate, ScopeEnforcer, PostToolHook, AutonomousRecovery       | 59             |
| **3** | AI-Native Git Layer    | Intent-code traceability via hashing & traces   | HashUtils, SemanticClassifier, TraceLogger, SpecifyParser                                   | 75             |
| **4** | Parallel Orchestration | Multi-agent concurrency, context, supervision   | OptimisticLock, AstPatchValidator, LessonRecorder, ContextCompactor, SupervisorOrchestrator | 126            |
| **5** | Gap Closure            | Session state, .specify/ fallback, MCP patching | Additions to HookEngine, IntentContextLoader, AstPatchValidator, write_to_file.ts           | Included above |
|       | **Total**              |                                                 | **19 source files**                                                                         | **270**        |
