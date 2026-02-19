import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { SpecifyParser } from "../SpecifyParser"
import type { SpecRequirement } from "../SpecifyParser"

const MOCK_CWD = "/test/workspace"
const SPECIFY_DIR = path.join(MOCK_CWD, ".specify")

/** Markdown with YAML frontmatter containing id, name, status */
const FRONTMATTER_SPEC = `---
id: REQ-001
name: User Authentication
status: IN_PROGRESS
---

# User Authentication

## Constraints
- Must use OAuth2 flow
- Session timeout: 30 minutes

## Owned Scope
- src/auth/**
- src/middleware/auth.ts

## Acceptance Criteria
- User can log in with email/password
- Session persists across page reloads
`

/** Markdown with heading-based ID (no frontmatter) */
const HEADING_SPEC = `# REQ-002: Data Export Feature

## Constraints
- Export must support CSV and JSON

## Scope
- src/export/**

## Criteria
- User can export up to 10,000 rows
`

/** Markdown with inline ID pattern (no frontmatter, no heading ID) */
const INLINE_SPEC = `# Search Improvements

Requirement ID: REQ-003

This requirement covers improvements to the search functionality.

## Constraints
- Must support fuzzy matching
- Response time < 200ms
`

/** Markdown with no ID at all */
const NO_ID_SPEC = `# Some Random Document

This document has no requirement ID anywhere.

## Notes
- Just some notes
`

/** Markdown with just frontmatter id (no name/status) */
const MINIMAL_SPEC = `---
id: REQ-004
---

Minimal requirement with just an ID.
`

vi.mock("node:fs")

const mockExistsSync = vi.mocked(fs.existsSync)
const mockReaddirSync = vi.mocked(fs.readdirSync)
const mockReadFileSync = vi.mocked(fs.readFileSync)
const mockStatSync = vi.mocked(fs.statSync)

describe("SpecifyParser", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("scanSpecifyDir", () => {
		it("returns empty array when .specify/ does not exist", () => {
			mockExistsSync.mockReturnValue(false)

			const result = SpecifyParser.scanSpecifyDir(MOCK_CWD)

			expect(result).toEqual([])
			expect(mockExistsSync).toHaveBeenCalledWith(SPECIFY_DIR)
		})

		it("returns only .md files from .specify/ directory", () => {
			mockExistsSync.mockReturnValue(true)
			mockReaddirSync.mockReturnValue(["req-001.md", "req-002.md", "readme.txt", "data.json"] as any)
			mockStatSync.mockReturnValue({ isFile: () => true } as fs.Stats)

			const result = SpecifyParser.scanSpecifyDir(MOCK_CWD)

			expect(result).toHaveLength(2)
			expect(result[0]).toContain("req-001.md")
			expect(result[1]).toContain("req-002.md")
		})

		it("handles readdirSync errors gracefully", () => {
			mockExistsSync.mockReturnValue(true)
			mockReaddirSync.mockImplementation(() => {
				throw new Error("Permission denied")
			})

			const result = SpecifyParser.scanSpecifyDir(MOCK_CWD)

			expect(result).toEqual([])
		})
	})

	describe("parseSpecFile", () => {
		it("extracts requirement from YAML frontmatter", () => {
			mockReadFileSync.mockReturnValue(FRONTMATTER_SPEC)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "auth.md"), MOCK_CWD)

			expect(result).not.toBeNull()
			expect(result!.id).toBe("REQ-001")
			expect(result!.name).toBe("User Authentication")
			expect(result!.status).toBe("IN_PROGRESS")
			expect(result!.sourceFile).toBe(".specify/auth.md")
		})

		it("extracts constraints from ## Constraints section", () => {
			mockReadFileSync.mockReturnValue(FRONTMATTER_SPEC)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "auth.md"), MOCK_CWD)

			expect(result!.constraints).toContain("Must use OAuth2 flow")
			expect(result!.constraints).toContain("Session timeout: 30 minutes")
		})

		it("extracts owned_scope from ## Owned Scope section", () => {
			mockReadFileSync.mockReturnValue(FRONTMATTER_SPEC)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "auth.md"), MOCK_CWD)

			expect(result!.owned_scope).toContain("src/auth/**")
			expect(result!.owned_scope).toContain("src/middleware/auth.ts")
		})

		it("extracts acceptance criteria", () => {
			mockReadFileSync.mockReturnValue(FRONTMATTER_SPEC)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "auth.md"), MOCK_CWD)

			expect(result!.acceptance_criteria).toContain("User can log in with email/password")
			expect(result!.acceptance_criteria).toContain("Session persists across page reloads")
		})

		it("extracts requirement from heading pattern (no frontmatter)", () => {
			mockReadFileSync.mockReturnValue(HEADING_SPEC)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "export.md"), MOCK_CWD)

			expect(result).not.toBeNull()
			expect(result!.id).toBe("REQ-002")
			expect(result!.name).toBe("Data Export Feature")
			expect(result!.status).toBe("ACTIVE") // default
		})

		it("extracts requirement from inline ID pattern", () => {
			mockReadFileSync.mockReturnValue(INLINE_SPEC)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "search.md"), MOCK_CWD)

			expect(result).not.toBeNull()
			expect(result!.id).toBe("REQ-003")
			expect(result!.status).toBe("ACTIVE") // default
		})

		it("returns null when no ID is found", () => {
			mockReadFileSync.mockReturnValue(NO_ID_SPEC)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "notes.md"), MOCK_CWD)

			expect(result).toBeNull()
		})

		it("handles minimal spec with just frontmatter id", () => {
			mockReadFileSync.mockReturnValue(MINIMAL_SPEC)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "minimal.md"), MOCK_CWD)

			expect(result).not.toBeNull()
			expect(result!.id).toBe("REQ-004")
			expect(result!.name).toBe("minimal") // filename sans extension
			expect(result!.status).toBe("ACTIVE") // default
		})

		it("stores raw content for further processing", () => {
			mockReadFileSync.mockReturnValue(FRONTMATTER_SPEC)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "auth.md"), MOCK_CWD)

			expect(result!.rawContent).toBe(FRONTMATTER_SPEC)
		})
	})

	describe("extractRequirements", () => {
		it("returns empty array when .specify/ does not exist", () => {
			mockExistsSync.mockReturnValue(false)

			const result = SpecifyParser.extractRequirements(MOCK_CWD)

			expect(result).toEqual([])
		})

		it("parses all markdown files and returns valid requirements", () => {
			mockExistsSync.mockReturnValue(true)
			mockReaddirSync.mockReturnValue(["auth.md", "export.md", "notes.md"] as any)
			mockStatSync.mockReturnValue({ isFile: () => true } as fs.Stats)

			// Return different content based on file path
			mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
				const fp = String(filePath)
				if (fp.includes("auth.md")) return FRONTMATTER_SPEC
				if (fp.includes("export.md")) return HEADING_SPEC
				if (fp.includes("notes.md")) return NO_ID_SPEC
				return ""
			})

			const result = SpecifyParser.extractRequirements(MOCK_CWD)

			// Only auth.md and export.md have valid IDs (notes.md has no ID)
			expect(result).toHaveLength(2)
			expect(result.map((r) => r.id)).toContain("REQ-001")
			expect(result.map((r) => r.id)).toContain("REQ-002")
		})

		it("skips files that fail to parse without crashing", () => {
			mockExistsSync.mockReturnValue(true)
			mockReaddirSync.mockReturnValue(["good.md", "broken.md"] as any)
			mockStatSync.mockReturnValue({ isFile: () => true } as fs.Stats)

			mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
				const fp = String(filePath)
				if (fp.includes("broken.md")) throw new Error("Read error")
				return FRONTMATTER_SPEC
			})

			const result = SpecifyParser.extractRequirements(MOCK_CWD)

			// Only the good file should be parsed
			expect(result).toHaveLength(1)
			expect(result[0].id).toBe("REQ-001")
		})
	})

	describe("findRequirement", () => {
		beforeEach(() => {
			mockExistsSync.mockReturnValue(true)
			mockReaddirSync.mockReturnValue(["auth.md", "export.md"] as any)
			mockStatSync.mockReturnValue({ isFile: () => true } as fs.Stats)
			mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
				const fp = String(filePath)
				if (fp.includes("auth.md")) return FRONTMATTER_SPEC
				if (fp.includes("export.md")) return HEADING_SPEC
				return ""
			})
		})

		it("finds a requirement by ID", () => {
			const result = SpecifyParser.findRequirement(MOCK_CWD, "REQ-001")

			expect(result).not.toBeNull()
			expect(result!.id).toBe("REQ-001")
			expect(result!.name).toBe("User Authentication")
		})

		it("returns null for non-existent requirement ID", () => {
			const result = SpecifyParser.findRequirement(MOCK_CWD, "REQ-999")

			expect(result).toBeNull()
		})
	})

	describe("toIntentEntry", () => {
		it("converts a SpecRequirement to IntentEntry format", () => {
			const req: SpecRequirement = {
				id: "REQ-001",
				name: "User Auth",
				status: "ACTIVE",
				sourceFile: ".specify/auth.md",
				constraints: ["Use OAuth2"],
				owned_scope: ["src/auth/**"],
				acceptance_criteria: ["User can log in"],
				rawContent: "test",
			}

			const entry = SpecifyParser.toIntentEntry(req)

			expect(entry.id).toBe("REQ-001")
			expect(entry.name).toBe("User Auth")
			expect(entry.status).toBe("ACTIVE")
			expect(entry.constraints).toEqual(["Use OAuth2"])
			expect(entry.owned_scope).toEqual(["src/auth/**"])
			expect(entry.acceptance_criteria).toEqual(["User can log in"])
		})

		it("defaults owned_scope to ['**/*'] when empty", () => {
			const req: SpecRequirement = {
				id: "REQ-002",
				name: "Test",
				status: "ACTIVE",
				sourceFile: ".specify/test.md",
				constraints: [],
				owned_scope: [],
				acceptance_criteria: [],
				rawContent: "",
			}

			const entry = SpecifyParser.toIntentEntry(req)

			expect(entry.owned_scope).toEqual(["**/*"])
		})
	})

	describe("extraction priority", () => {
		it("prefers frontmatter ID over heading ID", () => {
			const mixedContent = `---
id: REQ-100
name: From Frontmatter
---

# REQ-200: From Heading

Some content.
`
			mockReadFileSync.mockReturnValue(mixedContent)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "mixed.md"), MOCK_CWD)

			expect(result!.id).toBe("REQ-100")
			expect(result!.name).toBe("From Frontmatter")
		})

		it("uses heading when no frontmatter is present", () => {
			const headingOnly = `# REQ-300: Heading Only

Requirement ID: REQ-400
`
			mockReadFileSync.mockReturnValue(headingOnly)

			const result = SpecifyParser.parseSpecFile(path.join(SPECIFY_DIR, "heading.md"), MOCK_CWD)

			expect(result!.id).toBe("REQ-300")
		})
	})
})
