import { describe, it, expect } from "vitest"
import { SemanticClassifier, MutationClass } from "../SemanticClassifier"

describe("SemanticClassifier", () => {
	describe("classify — new files", () => {
		it("classifies new file creation as INTENT_EVOLUTION", () => {
			const result = SemanticClassifier.classify("", 'export function newFeature() { return "hello"; }')
			expect(result.mutationClass).toBe(MutationClass.INTENT_EVOLUTION)
			expect(result.score).toBe(1)
		})

		it("sets all signals to max for new files", () => {
			const result = SemanticClassifier.classify("", "const x = 42;")
			expect(result.signals.importDelta).toBe(1)
			expect(result.signals.exportDelta).toBe(1)
			expect(result.signals.signatureDelta).toBe(1)
			expect(result.signals.lineCountRatio).toBe(1)
			expect(result.signals.newSymbolRatio).toBe(1)
		})
	})

	describe("classify — refactors", () => {
		it("classifies variable rename as AST_REFACTOR", () => {
			const old = "const oldName = 42;\nconsole.log(oldName);"
			const newContent = "const newName = 42;\nconsole.log(newName);"
			const result = SemanticClassifier.classify(old, newContent)
			expect(result.mutationClass).toBe(MutationClass.AST_REFACTOR)
			expect(result.score).toBeLessThan(0.35)
		})

		it("classifies whitespace-only changes as AST_REFACTOR", () => {
			const old = "function foo(){\nreturn 42;\n}"
			const newContent = "function foo() {\n  return 42;\n}"
			const result = SemanticClassifier.classify(old, newContent)
			expect(result.mutationClass).toBe(MutationClass.AST_REFACTOR)
		})

		it("classifies comment additions as AST_REFACTOR", () => {
			// Use a multi-line file so adding one comment line is a small
			// percentage change, not 100% expansion on a single-line file.
			const old = ["function foo() {", "  const x = 1;", "  const y = 2;", "  return x + y;", "}"].join("\n")
			const newContent = [
				"// Adds two numbers",
				"function foo() {",
				"  const x = 1;",
				"  const y = 2;",
				"  return x + y;",
				"}",
			].join("\n")
			const result = SemanticClassifier.classify(old, newContent)
			expect(result.mutationClass).toBe(MutationClass.AST_REFACTOR)
		})
	})

	describe("classify — intent evolution", () => {
		it("classifies adding new exported function as INTENT_EVOLUTION", () => {
			const old = "export function existing() { return 1; }"
			const newContent =
				"export function existing() { return 1; }\n" +
				"export function newFeature() { return 2; }\n" +
				"export function anotherNew() { return 3; }"
			const result = SemanticClassifier.classify(old, newContent)
			expect(result.mutationClass).toBe(MutationClass.INTENT_EVOLUTION)
		})

		it("classifies adding new imports + exports as INTENT_EVOLUTION", () => {
			const old = 'import { a } from "mod-a";\nexport const x = 1;'
			const newContent =
				'import { a } from "mod-a";\n' +
				'import { b } from "mod-b";\n' +
				'import { c } from "mod-c";\n' +
				"export const x = 1;\n" +
				"export function newEndpoint() { return b + c; }"
			const result = SemanticClassifier.classify(old, newContent)
			expect(result.mutationClass).toBe(MutationClass.INTENT_EVOLUTION)
		})
	})

	describe("classify — score computation", () => {
		it("returns a score between 0 and 1", () => {
			const result = SemanticClassifier.classify("const a = 1;", "const a = 1;\nconst b = 2;")
			expect(result.score).toBeGreaterThanOrEqual(0)
			expect(result.score).toBeLessThanOrEqual(1)
		})

		it("provides a threshold in the result", () => {
			const result = SemanticClassifier.classify("const a = 1;", "const b = 2;")
			expect(result.threshold).toBe(0.35)
		})

		it("includes human-readable reasoning", () => {
			const result = SemanticClassifier.classify("const a = 1;", "const b = 2;")
			expect(result.reasoning).toContain("Classification:")
		})
	})

	describe("classifyWithOverride", () => {
		it("uses agent-provided mutation class", () => {
			const result = SemanticClassifier.classifyWithOverride("AST_REFACTOR", "const a = 1;", "const b = 1;")
			expect(result.mutationClass).toBe(MutationClass.AST_REFACTOR)
		})

		it("records agreement when auto-classification matches", () => {
			const result = SemanticClassifier.classifyWithOverride("AST_REFACTOR", "const a = 1;", "const b = 1;")
			expect(result.reasoning).toContain("agrees")
		})

		it("records disagreement when auto-classification differs", () => {
			// Agent says REFACTOR but it's clearly a new file (all signals max)
			const result = SemanticClassifier.classifyWithOverride(
				"AST_REFACTOR",
				"",
				"export function brand_new() { return 42; }",
			)
			expect(result.reasoning).toContain("disagrees")
		})

		it("normalizes agent input (case-insensitive)", () => {
			const result = SemanticClassifier.classifyWithOverride(
				"intent_evolution",
				"const a = 1;",
				"const a = 1;\nconst b = 2;",
			)
			expect(result.mutationClass).toBe(MutationClass.INTENT_EVOLUTION)
		})
	})

	describe("computeSignals", () => {
		it("detects new imports", () => {
			const old = 'import { a } from "a";'
			const newContent = 'import { a } from "a";\nimport { b } from "b";'
			const signals = SemanticClassifier.computeSignals(old, newContent)
			expect(signals.importDelta).toBeGreaterThan(0)
		})

		it("detects new exports", () => {
			const old = "export const a = 1;"
			const newContent = "export const a = 1;\nexport const b = 2;"
			const signals = SemanticClassifier.computeSignals(old, newContent)
			expect(signals.exportDelta).toBeGreaterThan(0)
		})

		it("detects line count expansion", () => {
			const old = "line1"
			const newContent = "line1\nline2\nline3\nline4"
			const signals = SemanticClassifier.computeSignals(old, newContent)
			expect(signals.lineCountRatio).toBeGreaterThan(0)
		})

		it("returns zero signals for identical content", () => {
			const content = "const x = 42;"
			const signals = SemanticClassifier.computeSignals(content, content)
			expect(signals.importDelta).toBe(0)
			expect(signals.exportDelta).toBe(0)
			expect(signals.lineCountRatio).toBe(0)
		})
	})

	describe("computeScore", () => {
		it("returns 0 for zero signals", () => {
			const score = SemanticClassifier.computeScore({
				importDelta: 0,
				exportDelta: 0,
				signatureDelta: 0,
				lineCountRatio: 0,
				newSymbolRatio: 0,
			})
			expect(score).toBe(0)
		})

		it("returns weighted sum of signals", () => {
			const score = SemanticClassifier.computeScore({
				importDelta: 1,
				exportDelta: 1,
				signatureDelta: 1,
				lineCountRatio: 1,
				newSymbolRatio: 1,
			})
			// Sum of all weights should be 1.0
			expect(score).toBeCloseTo(1, 5)
		})
	})
})
