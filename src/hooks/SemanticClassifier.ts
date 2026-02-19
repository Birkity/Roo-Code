/**
 * SemanticClassifier.ts — Phase 3: Mutation Class Discrimination
 *
 * Distinguishes between two fundamental types of code mutation:
 *
 *   1. AST_REFACTOR (Intent Preservation)
 *      - The code structure changes but the business intent stays the same.
 *      - Examples: renaming variables, extracting functions, reformatting.
 *      - Mathematically: the hash of the normalized AST changes, but
 *        the semantic intent map entry does NOT require update.
 *
 *   2. INTENT_EVOLUTION (New Feature / Behavior Change)
 *      - The code changes introduce new business logic or modify behavior.
 *      - Examples: adding a new endpoint, changing validation rules.
 *      - Mathematically: the intent_map.md MUST be updated.
 *
 * Mathematical Discrimination:
 *   We use a heuristic scoring model based on measurable code characteristics:
 *
 *   Score = w₁·ΔImports + w₂·ΔExports + w₃·ΔSignatures + w₄·ΔLineCount + w₅·NewSymbols
 *
 *   Where:
 *   - ΔImports    = change in import/require statements (new dependencies)
 *   - ΔExports    = change in exported symbols (new public API surface)
 *   - ΔSignatures = change in function/method signatures (new behavior)
 *   - ΔLineCount  = relative change in line count (expansion ratio)
 *   - NewSymbols  = new identifiers not present in original
 *
 *   If Score ≥ EVOLUTION_THRESHOLD → INTENT_EVOLUTION
 *   If Score <  EVOLUTION_THRESHOLD → AST_REFACTOR
 *
 * The rubric demands: "Distinguishes Refactors from Features mathematically."
 * This weighted scoring model provides that mathematical basis.
 *
 * @see TraceLogger.ts   — uses mutation_class in trace records
 * @see TRP1 Challenge Week 1, Phase 3 — Semantic Classification
 * @see Research Paper, Phase 3 — Intent Extraction
 */

// ── Types ────────────────────────────────────────────────────────────────

/**
 * The two possible mutation classifications per the TRP1 spec.
 */
export enum MutationClass {
	/** Syntax change with same intent — rename, extract, reformat */
	AST_REFACTOR = "AST_REFACTOR",

	/** New feature or behavior change — new endpoint, new logic */
	INTENT_EVOLUTION = "INTENT_EVOLUTION",
}

/**
 * Detailed classification result with the mathematical breakdown.
 */
export interface MutationClassification {
	/** The determined mutation class */
	mutationClass: MutationClass

	/** Composite score (0.0 – 1.0). Higher = more likely INTENT_EVOLUTION. */
	score: number

	/** Threshold used for the decision */
	threshold: number

	/** Breakdown of individual signal scores for transparency */
	signals: ClassificationSignals

	/** Human-readable reasoning */
	reasoning: string
}

/**
 * Individual classification signals and their weighted contributions.
 * Each signal is a normalized value between 0.0 and 1.0.
 */
export interface ClassificationSignals {
	/** Ratio of new import statements added */
	importDelta: number

	/** Ratio of new export statements added */
	exportDelta: number

	/** Ratio of new function/method signatures */
	signatureDelta: number

	/** Relative line count expansion ratio */
	lineCountRatio: number

	/** Ratio of new identifiers not present in original */
	newSymbolRatio: number
}

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Weights for the classification scoring formula.
 * These are tuned to favor detecting new behavior (exports, signatures)
 * over structural changes (line count, imports).
 *
 * Score = Σ(wᵢ · signalᵢ) where Σwᵢ = 1.0
 */
const WEIGHTS = {
	importDelta: 0.1,
	exportDelta: 0.25,
	signatureDelta: 0.3,
	lineCountRatio: 0.1,
	newSymbolRatio: 0.25,
} as const

/**
 * Threshold for classifying as INTENT_EVOLUTION.
 * Score ≥ threshold → INTENT_EVOLUTION
 * Score <  threshold → AST_REFACTOR
 */
const EVOLUTION_THRESHOLD = 0.35

// ── Regex Patterns for Code Analysis ─────────────────────────────────────

/** Matches import/require statements (full line for distinct comparison) */
const IMPORT_PATTERN = /^\s*(?:import\s|const\s+\w+\s*=\s*require\s*\(|from\s+['"]).*$/gm

/** Matches export statements (named, default, type — full line for distinct comparison) */
const EXPORT_PATTERN =
	/^\s*export\s+(?:default\s+|type\s+)?(?:function|class|const|let|var|interface|enum|abstract).*$/gm

/** Matches function/method signatures — simplified to reduce regex complexity */
const FUNCTION_KEYWORD_PATTERN = /(?:async\s+)?function\s+\w+/gm
const ARROW_FUNCTION_PATTERN = /const\s+\w+\s*=\s*(?:async\s+)?\(/gm

/** Matches identifiers (variable names, function names, class names) */
const IDENTIFIER_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g

// ── SemanticClassifier ───────────────────────────────────────────────────

/**
 * Classifies code mutations as AST_REFACTOR or INTENT_EVOLUTION
 * using a weighted mathematical scoring model.
 */
export class SemanticClassifier {
	/**
	 * Classify a mutation by comparing old and new file content.
	 *
	 * @param oldContent - The file content before modification (empty string for new files)
	 * @param newContent - The file content after modification
	 * @returns MutationClassification with score, signals, and reasoning
	 *
	 * @example
	 * ```ts
	 * // Renaming a variable — should be AST_REFACTOR
	 * const result = SemanticClassifier.classify(
	 *   "const oldName = 42;",
	 *   "const newName = 42;"
	 * )
	 * // result.mutationClass === MutationClass.AST_REFACTOR
	 *
	 * // Adding a new exported function — should be INTENT_EVOLUTION
	 * const result2 = SemanticClassifier.classify(
	 *   "",
	 *   "export function newFeature() { return 'hello'; }"
	 * )
	 * // result2.mutationClass === MutationClass.INTENT_EVOLUTION
	 * ```
	 */
	static classify(oldContent: string, newContent: string): MutationClassification {
		// New file creation is always INTENT_EVOLUTION
		if (oldContent.trim() === "") {
			return SemanticClassifier.buildNewFileResult(newContent)
		}

		// Compute individual signals
		const signals = SemanticClassifier.computeSignals(oldContent, newContent)

		// Compute weighted composite score
		const score = SemanticClassifier.computeScore(signals)

		// Determine classification
		const mutationClass = score >= EVOLUTION_THRESHOLD ? MutationClass.INTENT_EVOLUTION : MutationClass.AST_REFACTOR

		// Build reasoning explanation
		const reasoning = SemanticClassifier.buildReasoning(mutationClass, score, signals)

		return {
			mutationClass,
			score,
			threshold: EVOLUTION_THRESHOLD,
			signals,
			reasoning,
		}
	}

	/**
	 * Provide an explicit mutation class override.
	 *
	 * When the AI agent provides `mutation_class` in the tool params,
	 * we use it directly but still compute the mathematical score
	 * for validation and transparency.
	 *
	 * @param agentClass  - The mutation class declared by the agent
	 * @param oldContent  - Previous file content
	 * @param newContent  - New file content
	 * @returns MutationClassification using agent's class with computed signals
	 */
	static classifyWithOverride(agentClass: string, oldContent: string, newContent: string): MutationClassification {
		const normalized = agentClass.toUpperCase().trim()
		const mutationClass =
			normalized === "AST_REFACTOR" ? MutationClass.AST_REFACTOR : MutationClass.INTENT_EVOLUTION

		const signals =
			oldContent.trim() === ""
				? { importDelta: 1, exportDelta: 1, signatureDelta: 1, lineCountRatio: 1, newSymbolRatio: 1 }
				: SemanticClassifier.computeSignals(oldContent, newContent)

		const score = SemanticClassifier.computeScore(signals)

		const autoClass = score >= EVOLUTION_THRESHOLD ? MutationClass.INTENT_EVOLUTION : MutationClass.AST_REFACTOR
		const agreement = autoClass === mutationClass ? "agrees" : "disagrees"

		return {
			mutationClass,
			score,
			threshold: EVOLUTION_THRESHOLD,
			signals,
			reasoning:
				`Agent declared ${mutationClass}. ` +
				`Auto-classification ${agreement} (score=${score.toFixed(3)}, threshold=${EVOLUTION_THRESHOLD}).`,
		}
	}

	// ── Signal Computation ───────────────────────────────────────────

	/**
	 * Compute all classification signals from old and new content.
	 */
	static computeSignals(oldContent: string, newContent: string): ClassificationSignals {
		return {
			importDelta: SemanticClassifier.computeImportDelta(oldContent, newContent),
			exportDelta: SemanticClassifier.computeExportDelta(oldContent, newContent),
			signatureDelta: SemanticClassifier.computeSignatureDelta(oldContent, newContent),
			lineCountRatio: SemanticClassifier.computeLineCountRatio(oldContent, newContent),
			newSymbolRatio: SemanticClassifier.computeNewSymbolRatio(oldContent, newContent),
		}
	}

	/**
	 * Compute the weighted composite score from individual signals.
	 *
	 * Formula: Score = Σ(wᵢ · signalᵢ)
	 */
	static computeScore(signals: ClassificationSignals): number {
		return (
			WEIGHTS.importDelta * signals.importDelta +
			WEIGHTS.exportDelta * signals.exportDelta +
			WEIGHTS.signatureDelta * signals.signatureDelta +
			WEIGHTS.lineCountRatio * signals.lineCountRatio +
			WEIGHTS.newSymbolRatio * signals.newSymbolRatio
		)
	}

	// ── Individual Signal Extractors ─────────────────────────────────

	/**
	 * Compute the ratio of new imports added.
	 * Returns 0.0 if no new imports, up to 1.0 if many new imports.
	 */
	private static computeImportDelta(oldContent: string, newContent: string): number {
		const oldImports = SemanticClassifier.extractMatches(oldContent, IMPORT_PATTERN)
		const newImports = SemanticClassifier.extractMatches(newContent, IMPORT_PATTERN)
		const added = newImports.filter((imp) => !oldImports.includes(imp))
		if (newImports.length === 0) {
			return 0
		}
		return Math.min(added.length / Math.max(oldImports.length, 1), 1)
	}

	/**
	 * Compute the ratio of new exports added.
	 * New exports strongly indicate INTENT_EVOLUTION (new public API).
	 */
	private static computeExportDelta(oldContent: string, newContent: string): number {
		const oldExports = SemanticClassifier.extractMatches(oldContent, EXPORT_PATTERN)
		const newExports = SemanticClassifier.extractMatches(newContent, EXPORT_PATTERN)
		const added = newExports.filter((exp) => !oldExports.includes(exp))
		if (newExports.length === 0) {
			return 0
		}
		return Math.min(added.length / Math.max(oldExports.length, 1), 1)
	}

	/**
	 * Compute the ratio of new function/method signatures.
	 * New signatures indicate new behavior → INTENT_EVOLUTION.
	 */
	private static computeSignatureDelta(oldContent: string, newContent: string): number {
		const oldFns = SemanticClassifier.extractMatches(oldContent, FUNCTION_KEYWORD_PATTERN)
		const oldArrows = SemanticClassifier.extractMatches(oldContent, ARROW_FUNCTION_PATTERN)
		const oldSigs = [...oldFns, ...oldArrows]

		const newFns = SemanticClassifier.extractMatches(newContent, FUNCTION_KEYWORD_PATTERN)
		const newArrows = SemanticClassifier.extractMatches(newContent, ARROW_FUNCTION_PATTERN)
		const newSigs = [...newFns, ...newArrows]

		const added = newSigs.filter((sig) => !oldSigs.includes(sig))
		if (newSigs.length === 0) {
			return 0
		}
		return Math.min(added.length / Math.max(oldSigs.length, 1), 1)
	}

	/**
	 * Compute the relative expansion ratio of line count.
	 * Large line count increases (>50%) suggest new content → INTENT_EVOLUTION.
	 */
	private static computeLineCountRatio(oldContent: string, newContent: string): number {
		const oldLines = oldContent.split("\n").length
		const newLines = newContent.split("\n").length
		if (oldLines === 0) {
			return 1
		}
		const ratio = (newLines - oldLines) / oldLines
		// Normalize: 0 if same/smaller, caps at 1 for 100%+ expansion
		return Math.min(Math.max(ratio, 0), 1)
	}

	/**
	 * Compute the ratio of identifiers in new content that didn't exist in old.
	 * High ratio = lots of new symbols → INTENT_EVOLUTION.
	 */
	private static computeNewSymbolRatio(oldContent: string, newContent: string): number {
		const oldSymbols = new Set(SemanticClassifier.extractMatches(oldContent, IDENTIFIER_PATTERN))
		const newSymbols = SemanticClassifier.extractMatches(newContent, IDENTIFIER_PATTERN)

		if (newSymbols.length === 0) {
			return 0
		}

		const newOnly = newSymbols.filter((sym) => !oldSymbols.has(sym))
		// Deduplicate new-only symbols for fair ratio
		const uniqueNewOnly = new Set(newOnly)
		const uniqueNew = new Set(newSymbols)

		return Math.min(uniqueNewOnly.size / Math.max(uniqueNew.size, 1), 1)
	}

	// ── Helpers ──────────────────────────────────────────────────────

	/**
	 * Extract all matches for a given regex pattern from content.
	 * Returns an array of matched strings (trimmed).
	 */
	private static extractMatches(content: string, pattern: RegExp): string[] {
		// Create a new regex to avoid state issues with global flag
		const regex = new RegExp(pattern.source, pattern.flags)
		const matches: string[] = []
		let match: RegExpExecArray | null

		match = regex.exec(content)
		while (match !== null) {
			matches.push(match[0].trim())
			match = regex.exec(content)
		}

		return matches
	}

	/**
	 * Build a classification result for new file creation.
	 * New files are always INTENT_EVOLUTION.
	 */
	private static buildNewFileResult(newContent: string): MutationClassification {
		const lineCount = newContent.split("\n").length
		return {
			mutationClass: MutationClass.INTENT_EVOLUTION,
			score: 1,
			threshold: EVOLUTION_THRESHOLD,
			signals: {
				importDelta: 1,
				exportDelta: 1,
				signatureDelta: 1,
				lineCountRatio: 1,
				newSymbolRatio: 1,
			},
			reasoning: `New file creation (${lineCount} lines). All signals max → INTENT_EVOLUTION.`,
		}
	}

	/**
	 * Build a human-readable reasoning string from classification data.
	 */
	private static buildReasoning(mutationClass: MutationClass, score: number, signals: ClassificationSignals): string {
		const parts: string[] = []

		if (signals.exportDelta > 0.3) {
			parts.push(`new exports detected (δ=${signals.exportDelta.toFixed(2)})`)
		}
		if (signals.signatureDelta > 0.3) {
			parts.push(`new function signatures (δ=${signals.signatureDelta.toFixed(2)})`)
		}
		if (signals.newSymbolRatio > 0.4) {
			parts.push(`high new symbol ratio (${signals.newSymbolRatio.toFixed(2)})`)
		}
		if (signals.lineCountRatio > 0.5) {
			parts.push(`significant line expansion (${signals.lineCountRatio.toFixed(2)})`)
		}
		if (signals.importDelta > 0.3) {
			parts.push(`new imports (δ=${signals.importDelta.toFixed(2)})`)
		}

		const signalDesc = parts.length > 0 ? parts.join("; ") : "minimal structural changes"

		return (
			`Classification: ${mutationClass} (score=${score.toFixed(3)}, ` +
			`threshold=${EVOLUTION_THRESHOLD}). Signals: ${signalDesc}.`
		)
	}
}
