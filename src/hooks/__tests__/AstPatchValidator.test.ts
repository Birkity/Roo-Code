import { describe, expect, it } from "vitest"

import { AstPatchValidator, PatchType } from "../AstPatchValidator"

/** Generate a multi-line file with N functions, each ~5 lines */
function generateLargeFile(funcCount: number): string {
	const lines: string[] = ['import { something } from "module"', ""]
	for (let i = 0; i < funcCount; i++) {
		lines.push(
			`export function func${i}(x: number): number {`,
			`  const y = x * ${i + 1}`,
			`  console.log(y)`,
			`  return y`,
			`}`,
			"",
		)
	}
	return lines.join("\n")
}

describe("AstPatchValidator", () => {
	describe("validate", () => {
		it("allows new file creation (empty old content)", () => {
			const result = AstPatchValidator.validate("write_to_file", "", "export function hello() { return 1; }")

			expect(result.valid).toBe(true)
			expect(result.patchType).toBe(PatchType.NEW_FILE)
			expect(result.isFullRewrite).toBe(false)
		})

		it("allows writes for non-validated tools", () => {
			const result = AstPatchValidator.validate("execute_command", "old", "new")

			expect(result.valid).toBe(true)
			expect(result.patchType).toBe(PatchType.MINOR_EDIT)
		})

		it("allows search-and-replace (inherently targeted)", () => {
			const result = AstPatchValidator.validate(
				"search_and_replace",
				"const x = 1;\nconst y = 2;",
				"const x = 99;\nconst y = 2;",
			)

			expect(result.valid).toBe(true)
			expect(result.patchType).toBe(PatchType.SEARCH_REPLACE)
		})

		it("allows small file full rewrites (below min line threshold)", () => {
			const small = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")
			const rewrite = Array.from({ length: 10 }, (_, i) => `CHANGED ${i}`).join("\n")

			const result = AstPatchValidator.validate("write_to_file", small, rewrite)

			expect(result.valid).toBe(true)
			expect(result.patchType).toBe(PatchType.MINOR_EDIT)
		})

		it("blocks full rewrites of large files", () => {
			const original = generateLargeFile(10) // ~60+ lines
			// Create a completely different file
			const rewrite = Array.from({ length: 60 }, (_, i) => `totally_new_line_${i}`).join("\n")

			const result = AstPatchValidator.validate("write_to_file", original, rewrite)

			expect(result.valid).toBe(false)
			expect(result.isFullRewrite).toBe(true)
			expect(result.patchType).toBe(PatchType.FULL_REWRITE)
			expect(result.guidance).toBeTruthy()
			expect(result.guidance).toContain("patch_guidance")
		})

		it("allows targeted edits to large files", () => {
			const original = generateLargeFile(10)
			const lines = original.split("\n")
			// Change just 2 lines
			lines[5] = "  const y = x * 999  // modified"
			lines[6] = "  console.log('modified')"
			const modified = lines.join("\n")

			const result = AstPatchValidator.validate("write_to_file", original, modified)

			expect(result.valid).toBe(true)
			expect(result.patchType).toBe(PatchType.MINOR_EDIT)
		})

		it("validates apply_diff with well-formed hunks", () => {
			const diff = [
				"--- a/src/utils.ts",
				"+++ b/src/utils.ts",
				"@@ -10,3 +10,4 @@",
				" unchanged line",
				"-old line",
				"+new line",
				"+added line",
			].join("\n")

			const result = AstPatchValidator.validate("apply_diff", "old", "new", { diff })

			expect(result.valid).toBe(true)
			expect(result.patchType).toBe(PatchType.TARGETED_DIFF)
		})

		it("allows apply_diff with no parseable diff content", () => {
			const result = AstPatchValidator.validate("apply_diff", "old", "new", {})

			expect(result.valid).toBe(true)
		})
	})

	describe("computeChangeRatio", () => {
		it("returns 0 for identical content", () => {
			const content = "line1\nline2\nline3"
			expect(AstPatchValidator.computeChangeRatio(content, content)).toBe(0)
		})

		it("returns ~1.0 for completely different content", () => {
			const old = "aaa\nbbb\nccc"
			const newC = "xxx\nyyy\nzzz"
			const ratio = AstPatchValidator.computeChangeRatio(old, newC)
			expect(ratio).toBeGreaterThan(0.8)
		})

		it("returns a moderate ratio for partial changes", () => {
			const old = "line1\nline2\nline3\nline4\nline5"
			const newC = "line1\nMODIFIED\nline3\nline4\nline5"
			const ratio = AstPatchValidator.computeChangeRatio(old, newC)
			expect(ratio).toBeGreaterThan(0)
			expect(ratio).toBeLessThan(0.5)
		})

		it("handles empty inputs", () => {
			expect(AstPatchValidator.computeChangeRatio("", "")).toBe(0)
		})
	})

	describe("extractSymbols", () => {
		it("detects function declarations", () => {
			const content = ["function hello() {", "  return 1", "}"].join("\n")

			const symbols = AstPatchValidator.extractSymbols(content)
			expect(symbols).toHaveLength(1)
			expect(symbols[0].nodeType).toBe("function")
			expect(symbols[0].symbolName).toBe("hello")
		})

		it("detects exported async functions", () => {
			const content = ["export async function fetchData() {", "  return await fetch('/api')", "}"].join("\n")

			const symbols = AstPatchValidator.extractSymbols(content)
			expect(symbols).toHaveLength(1)
			expect(symbols[0].nodeType).toBe("function")
			expect(symbols[0].symbolName).toBe("fetchData")
		})

		it("detects class declarations", () => {
			const content = ["export class MyService {", "  run() { return true }", "}"].join("\n")

			const symbols = AstPatchValidator.extractSymbols(content)
			expect(symbols.some((s) => s.nodeType === "class" && s.symbolName === "MyService")).toBe(true)
		})

		it("detects interface declarations", () => {
			const content = ["export interface Config {", "  name: string", "  value: number", "}"].join("\n")

			const symbols = AstPatchValidator.extractSymbols(content)
			expect(symbols.some((s) => s.nodeType === "interface" && s.symbolName === "Config")).toBe(true)
		})

		it("detects type declarations", () => {
			const content = ["export type Status = {", '  state: "active" | "inactive"', "}"].join("\n")

			const symbols = AstPatchValidator.extractSymbols(content)
			expect(symbols.some((s) => s.nodeType === "interface" && s.symbolName === "Status")).toBe(true)
		})

		it("returns empty for content without declarations", () => {
			const content = "// just a comment\nconst x = 1\n"
			const symbols = AstPatchValidator.extractSymbols(content)
			expect(symbols).toHaveLength(0)
		})
	})

	describe("identifyChangedSymbols", () => {
		it("detects added symbols", () => {
			const old = "function existing() { return 1 }\n"
			const newC = "function existing() { return 1 }\nfunction added() { return 2 }\n"

			const changed = AstPatchValidator.identifyChangedSymbols(old, newC)
			expect(changed.some((c) => c.symbolName === "added")).toBe(true)
		})

		it("detects removed symbols", () => {
			const old = "function a() { return 1 }\nfunction b() { return 2 }\n"
			const newC = "function a() { return 1 }\n"

			const changed = AstPatchValidator.identifyChangedSymbols(old, newC)
			expect(changed.some((c) => c.symbolName === "b")).toBe(true)
		})

		it("returns empty when no structural changes", () => {
			const content = "function same() { return 1 }\n"
			const changed = AstPatchValidator.identifyChangedSymbols(content, content)
			expect(changed).toHaveLength(0)
		})
	})

	describe("parseUnifiedDiff", () => {
		it("parses a single hunk", () => {
			const diff = [
				"--- a/file.ts",
				"+++ b/file.ts",
				"@@ -5,3 +5,4 @@",
				" context line",
				"-removed",
				"+added",
				"+extra",
			].join("\n")

			const hunks = AstPatchValidator.parseUnifiedDiff(diff)
			expect(hunks).toHaveLength(1)
			expect(hunks[0].oldStart).toBe(5)
			expect(hunks[0].oldCount).toBe(3)
			expect(hunks[0].newStart).toBe(5)
			expect(hunks[0].newCount).toBe(4)
		})

		it("parses multiple hunks", () => {
			const diff = ["@@ -1,2 +1,2 @@", "-old1", "+new1", "@@ -20,3 +20,3 @@", " ctx", "-old2", "+new2"].join("\n")

			const hunks = AstPatchValidator.parseUnifiedDiff(diff)
			expect(hunks).toHaveLength(2)
			expect(hunks[0].oldStart).toBe(1)
			expect(hunks[1].oldStart).toBe(20)
		})

		it("handles missing count (defaults to 1)", () => {
			const diff = "@@ -10 +10 @@\n content"
			const hunks = AstPatchValidator.parseUnifiedDiff(diff)
			expect(hunks).toHaveLength(1)
			expect(hunks[0].oldCount).toBe(1)
			expect(hunks[0].newCount).toBe(1)
		})

		it("returns empty for non-diff text", () => {
			const hunks = AstPatchValidator.parseUnifiedDiff("just some regular text")
			expect(hunks).toHaveLength(0)
		})
	})

	describe("patchMcpToolDefinitions", () => {
		it("patches write_to_file tool description with enforcement warning", () => {
			const tools = [
				{ name: "write_to_file", description: "Write content to a file.", parameters: {} },
				{ name: "read_file", description: "Read file contents.", parameters: {} },
			]

			const patched = AstPatchValidator.patchMcpToolDefinitions(tools)

			expect(patched).toHaveLength(2)
			expect(patched[0].description).toContain("AST-AWARE PATCH ENFORCEMENT")
			expect(patched[0].description).toContain("Full-file rewrites on files with >15 lines are BLOCKED")
			// read_file should not be patched
			expect(patched[1].description).toBe("Read file contents.")
		})

		it("patches insert_content and create_file tools", () => {
			const tools = [
				{ name: "insert_content", description: "Insert content." },
				{ name: "create_file", description: "Create a new file." },
				{ name: "apply_diff", description: "Apply a unified diff." },
			]

			const patched = AstPatchValidator.patchMcpToolDefinitions(tools)

			expect(patched[0].description).toContain("AST-AWARE PATCH ENFORCEMENT")
			expect(patched[1].description).toContain("AST-AWARE PATCH ENFORCEMENT")
			// apply_diff should NOT be patched (it's the preferred approach)
			expect(patched[2].description).toBe("Apply a unified diff.")
		})

		it("preserves original tool properties", () => {
			const tools = [
				{
					name: "write_to_file",
					description: "Write to file.",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			]

			const patched = AstPatchValidator.patchMcpToolDefinitions(tools)

			expect(patched[0].name).toBe("write_to_file")
			expect(patched[0].parameters).toEqual({ type: "object", properties: { path: { type: "string" } } })
		})

		it("returns empty array for empty input", () => {
			const patched = AstPatchValidator.patchMcpToolDefinitions([])
			expect(patched).toEqual([])
		})
	})

	describe("getToolDefinitionOverrides", () => {
		it("returns overrides for write_to_file and insert_content", () => {
			const overrides = AstPatchValidator.getToolDefinitionOverrides()

			expect(overrides).toHaveProperty("write_to_file")
			expect(overrides).toHaveProperty("insert_content")
			expect(overrides.write_to_file).toContain("AST-AWARE PATCH ENFORCEMENT")
			expect(overrides.write_to_file).toContain("intent_id")
			expect(overrides.write_to_file).toContain("mutation_class")
		})

		it("does not include non-write tools", () => {
			const overrides = AstPatchValidator.getToolDefinitionOverrides()

			expect(overrides).not.toHaveProperty("read_file")
			expect(overrides).not.toHaveProperty("apply_diff")
			expect(overrides).not.toHaveProperty("execute_command")
		})
	})
})
