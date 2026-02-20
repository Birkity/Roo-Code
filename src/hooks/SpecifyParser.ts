/** Parses `.specify/` markdown files to extract Requirement IDs and intent metadata. */

import * as fs from "node:fs"
import * as path from "node:path"

/** A parsed requirement extracted from a `.specify/` markdown file. */
export interface SpecRequirement {
	/** Unique Requirement ID (e.g., "REQ-001") */
	id: string

	/** Human-readable name */
	name: string

	/** Current status (defaults to "ACTIVE") */
	status: string

	/** Source file path (relative to cwd) */
	sourceFile: string

	/** Constraints extracted from the markdown */
	constraints: string[]

	/** Owned scope patterns extracted from the markdown */
	owned_scope: string[]

	/** Acceptance criteria extracted from the markdown */
	acceptance_criteria: string[]

	/** Raw markdown content of the spec file */
	rawContent: string
}

/** Matches YAML frontmatter delimiters */
const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---/

/** Matches requirement ID in frontmatter: `id: REQ-001` */
const FRONTMATTER_ID_PATTERN = /^id:\s*["']?([A-Z]+-\d+)["']?\s*$/m

/** Matches name/title in frontmatter */
const FRONTMATTER_NAME_PATTERN = /^(?:name|title):\s*["']?(.+?)["']?\s*$/m

/** Matches status in frontmatter */
const FRONTMATTER_STATUS_PATTERN = /^status:\s*["']?(.+?)["']?\s*$/m

/** Matches requirement ID in a heading: `# REQ-001: Feature Name` */
const HEADING_ID_PATTERN = /^#\s+([A-Z]+-\d+)(?::\s*(.+))?$/m

/** Matches inline requirement ID: `Requirement ID: REQ-001` */
const INLINE_ID_PATTERN = /Requirement\s+ID:\s*([A-Z]+-\d+)/i

/** Parses `.specify/` markdown files to extract requirement definitions. */
export class SpecifyParser {
	static extractRequirements(cwd: string): SpecRequirement[] {
		const specDir = path.join(cwd, ".specify")

		if (!fs.existsSync(specDir)) {
			return []
		}

		const mdFiles = SpecifyParser.scanSpecifyDir(cwd)
		const requirements: SpecRequirement[] = []

		for (const filePath of mdFiles) {
			try {
				const req = SpecifyParser.parseSpecFile(filePath, cwd)
				if (req) {
					requirements.push(req)
				}
			} catch (error) {
				console.warn(`[SpecifyParser] Failed to parse ${filePath}: ${error}`)
			}
		}

		return requirements
	}

	static findRequirement(cwd: string, reqId: string): SpecRequirement | null {
		const requirements = SpecifyParser.extractRequirements(cwd)
		return requirements.find((r) => r.id === reqId) ?? null
	}

	static scanSpecifyDir(cwd: string): string[] {
		const specDir = path.join(cwd, ".specify")

		if (!fs.existsSync(specDir)) {
			return []
		}

		try {
			const entries = fs.readdirSync(specDir)
			return entries
				.filter((entry) => entry.endsWith(".md"))
				.map((entry) => path.join(specDir, entry))
				.filter((filePath) => {
					try {
						return fs.statSync(filePath).isFile()
					} catch {
						return false
					}
				})
		} catch (error) {
			console.warn(`[SpecifyParser] Failed to scan .specify/ directory: ${error}`)
			return []
		}
	}

	/** Extracts a requirement from a markdown file. Tries frontmatter, heading, then inline ID patterns. */
	static parseSpecFile(filePath: string, cwd: string): SpecRequirement | null {
		const content = fs.readFileSync(filePath, "utf-8")
		const relativePath = path.relative(cwd, filePath).replaceAll("\\", "/")

		const { id, name, status } = SpecifyParser.extractIdentifiers(content, filePath)

		if (!id) {
			return null
		}

		const constraints = SpecifyParser.extractListSection(content, "constraints")
		const ownedScope = SpecifyParser.extractListSection(content, "owned.scope|scope|files")
		const criteria = SpecifyParser.extractListSection(content, "acceptance.criteria|criteria|done")

		return {
			id,
			name,
			status,
			sourceFile: relativePath,
			constraints,
			owned_scope: ownedScope,
			acceptance_criteria: criteria,
			rawContent: content,
		}
	}

	/** Tries frontmatter, heading, then inline pattern to extract ID/name/status. */
	private static extractIdentifiers(
		content: string,
		filePath: string,
	): { id: string | null; name: string; status: string } {
		let id: string | null = null
		let name = path.basename(filePath, ".md")
		let status = "ACTIVE"

		const frontmatter = FRONTMATTER_PATTERN.exec(content)?.[1]
		if (frontmatter) {
			id = FRONTMATTER_ID_PATTERN.exec(frontmatter)?.[1] ?? null
			name = FRONTMATTER_NAME_PATTERN.exec(frontmatter)?.[1] ?? name
			status = FRONTMATTER_STATUS_PATTERN.exec(frontmatter)?.[1] ?? status
		}

		if (!id) {
			const headingMatch = HEADING_ID_PATTERN.exec(content)
			if (headingMatch) {
				id = headingMatch[1]
				if (headingMatch[2]) name = headingMatch[2].trim()
			}
		}

		if (!id) {
			const inlineMatch = INLINE_ID_PATTERN.exec(content)
			if (inlineMatch) id = inlineMatch[1]
		}

		return { id, name, status }
	}

	/** Converts a SpecRequirement to an IntentEntry-compatible object. */
	static toIntentEntry(req: SpecRequirement): {
		id: string
		name: string
		status: string
		owned_scope: string[]
		constraints: string[]
		acceptance_criteria: string[]
	} {
		return {
			id: req.id,
			name: req.name,
			status: req.status,
			owned_scope: req.owned_scope.length > 0 ? req.owned_scope : ["**/*"],
			constraints: req.constraints,
			acceptance_criteria: req.acceptance_criteria,
		}
	}

	/** Extracts bullet-list items under a heading matching the given pattern. */
	private static extractListSection(content: string, headingPattern: string): string[] {
		const sectionRegex = new RegExp(String.raw`^#{1,3}\s+(?:${headingPattern})\s*$`, "im")

		const sectionMatch = sectionRegex.exec(content)
		if (!sectionMatch) {
			return []
		}

		const afterHeading = content.substring(sectionMatch.index + sectionMatch[0].length)
		const lines = afterHeading.split("\n")
		const items: string[] = []

		for (const line of lines) {
			const trimmed = line.trim()

			if (/^#{1,3}\s+/.test(trimmed)) {
				break
			}

			if (/^[-*]\s+/.test(trimmed)) {
				items.push(trimmed.replace(/^[-*]\s+/, ""))
			}
		}

		return items
	}
}
