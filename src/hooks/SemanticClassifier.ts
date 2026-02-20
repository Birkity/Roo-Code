/** Classifies code mutations as AST_REFACTOR or INTENT_EVOLUTION using weighted signal scoring. */

export enum MutationClass {
	AST_REFACTOR = "AST_REFACTOR",
	INTENT_EVOLUTION = "INTENT_EVOLUTION",
}

export interface MutationClassification {
	mutationClass: MutationClass
	/** Composite score (0.0 – 1.0). Higher = more likely INTENT_EVOLUTION. */
	score: number
	threshold: number
	signals: ClassificationSignals
	reasoning: string
}

/** Each signal is a normalized value between 0.0 and 1.0. */
export interface ClassificationSignals {
	importDelta: number
	exportDelta: number
	signatureDelta: number
	lineCountRatio: number
	newSymbolRatio: number
}

const WEIGHTS = {
	importDelta: 0.1,
	exportDelta: 0.25,
	signatureDelta: 0.3,
	lineCountRatio: 0.1,
	newSymbolRatio: 0.25,
} as const

const EVOLUTION_THRESHOLD = 0.35

/** Used for new file creation and agent override of empty files. */
const MAX_SIGNALS: ClassificationSignals = {
	importDelta: 1,
	exportDelta: 1,
	signatureDelta: 1,
	lineCountRatio: 1,
	newSymbolRatio: 1,
}

/** Matches import/require statements. */
const IMPORT_PATTERN = /^\s*(?:import\s|const\s+\w+\s*=\s*require\s*\(|from\s+['"]).*$/gm

/** Matches export statements. */
const EXPORT_PATTERN =
	/^\s*export\s+(?:default\s+|type\s+)?(?:function|class|const|let|var|interface|enum|abstract).*$/gm

/** Matches function/method signatures. */
const FUNCTION_KEYWORD_PATTERN = /(?:async\s+)?function\s+\w+/gm
const ARROW_FUNCTION_PATTERN = /const\s+\w+\s*=\s*(?:async\s+)?\(/gm

/** Matches identifiers (3+ chars). */
const IDENTIFIER_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g

export class SemanticClassifier {
	static classify(oldContent: string, newContent: string): MutationClassification {
		if (oldContent.trim() === "") {
			return SemanticClassifier.buildNewFileResult(newContent)
		}

		const signals = SemanticClassifier.computeSignals(oldContent, newContent)
		const score = SemanticClassifier.computeScore(signals)
		const mutationClass = score >= EVOLUTION_THRESHOLD ? MutationClass.INTENT_EVOLUTION : MutationClass.AST_REFACTOR
		const reasoning = SemanticClassifier.buildReasoning(mutationClass, score, signals)

		return {
			mutationClass,
			score,
			threshold: EVOLUTION_THRESHOLD,
			signals,
			reasoning,
		}
	}

	static classifyWithOverride(agentClass: string, oldContent: string, newContent: string): MutationClassification {
		const normalized = agentClass.toUpperCase().trim()
		const mutationClass =
			normalized === "AST_REFACTOR" ? MutationClass.AST_REFACTOR : MutationClass.INTENT_EVOLUTION

		const signals =
			oldContent.trim() === "" ? MAX_SIGNALS : SemanticClassifier.computeSignals(oldContent, newContent)

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

	static computeSignals(oldContent: string, newContent: string): ClassificationSignals {
		return {
			importDelta: SemanticClassifier.computeImportDelta(oldContent, newContent),
			exportDelta: SemanticClassifier.computeExportDelta(oldContent, newContent),
			signatureDelta: SemanticClassifier.computeSignatureDelta(oldContent, newContent),
			lineCountRatio: SemanticClassifier.computeLineCountRatio(oldContent, newContent),
			newSymbolRatio: SemanticClassifier.computeNewSymbolRatio(oldContent, newContent),
		}
	}

	static computeScore(signals: ClassificationSignals): number {
		return (
			WEIGHTS.importDelta * signals.importDelta +
			WEIGHTS.exportDelta * signals.exportDelta +
			WEIGHTS.signatureDelta * signals.signatureDelta +
			WEIGHTS.lineCountRatio * signals.lineCountRatio +
			WEIGHTS.newSymbolRatio * signals.newSymbolRatio
		)
	}

	private static computeImportDelta(oldContent: string, newContent: string): number {
		const oldImports = SemanticClassifier.extractMatches(oldContent, IMPORT_PATTERN)
		const newImports = SemanticClassifier.extractMatches(newContent, IMPORT_PATTERN)
		const added = newImports.filter((imp) => !oldImports.includes(imp))
		if (newImports.length === 0) {
			return 0
		}
		return Math.min(added.length / Math.max(oldImports.length, 1), 1)
	}

	private static computeExportDelta(oldContent: string, newContent: string): number {
		const oldExports = SemanticClassifier.extractMatches(oldContent, EXPORT_PATTERN)
		const newExports = SemanticClassifier.extractMatches(newContent, EXPORT_PATTERN)
		const added = newExports.filter((exp) => !oldExports.includes(exp))
		if (newExports.length === 0) {
			return 0
		}
		return Math.min(added.length / Math.max(oldExports.length, 1), 1)
	}

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

	private static computeLineCountRatio(oldContent: string, newContent: string): number {
		const oldLines = oldContent.split("\n").length
		const newLines = newContent.split("\n").length
		if (oldLines === 0) {
			return 1
		}
		const ratio = (newLines - oldLines) / oldLines
		return Math.min(Math.max(ratio, 0), 1)
	}

	private static computeNewSymbolRatio(oldContent: string, newContent: string): number {
		const oldSymbols = new Set(SemanticClassifier.extractMatches(oldContent, IDENTIFIER_PATTERN))
		const newSymbols = SemanticClassifier.extractMatches(newContent, IDENTIFIER_PATTERN)

		if (newSymbols.length === 0) {
			return 0
		}

		const newOnly = newSymbols.filter((sym) => !oldSymbols.has(sym))
		const uniqueNewOnly = new Set(newOnly)
		const uniqueNew = new Set(newSymbols)

		return Math.min(uniqueNewOnly.size / Math.max(uniqueNew.size, 1), 1)
	}

	private static extractMatches(content: string, pattern: RegExp): string[] {
		const regex = new RegExp(pattern.source, pattern.flags)
		const matches: string[] = []
		let match = regex.exec(content)
		while (match !== null) {
			matches.push(match[0].trim())
			match = regex.exec(content)
		}
		return matches
	}

	private static buildNewFileResult(newContent: string): MutationClassification {
		const lineCount = newContent.split("\n").length
		return {
			mutationClass: MutationClass.INTENT_EVOLUTION,
			score: 1,
			threshold: EVOLUTION_THRESHOLD,
			signals: MAX_SIGNALS,
			reasoning: `New file creation (${lineCount} lines). All signals max → INTENT_EVOLUTION.`,
		}
	}

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
