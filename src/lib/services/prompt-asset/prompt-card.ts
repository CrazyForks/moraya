/**
 * Prompt card — assemble a prompt asset together with its bound environment
 * context (background note + referenced files) into one block ready to paste
 * into a fresh AI session, and manage the `context-files` frontmatter binding.
 *
 * Pure functions — unit-testable. See docs/specs/prompt-asset.md §4.2
 * ("需求卡片 = 提示词 + 绑定的环境上下文").
 */
import { extractFrontmatter } from '$lib/utils/frontmatter'
import { parsePromptMeta } from './prompt-index'

export interface CardInput {
  /** The prompt text itself. */
  body: string
  /** Free-text background (frontmatter `context-notes`). */
  notes: string
  /** Resolved context files, in binding order. */
  files: Array<{ path: string; content: string }>
}

/** Localized section labels, supplied by the caller (keeps this module i18n-free). */
export interface CardLabels {
  /** Heading for the background note section, e.g. "Background". */
  background: string
  /** Heading prefix for each context file, e.g. "Context file" → "## Context file: path". */
  contextFile: string
}

/**
 * Assemble the full card text: background note, each context file's content,
 * then the prompt body — separated by horizontal rules. Sections with no
 * content are omitted. File/note text is inlined verbatim (trimmed).
 */
export function assemblePromptCard(input: CardInput, labels: CardLabels): string {
  const parts: string[] = []
  if (input.notes.trim()) {
    parts.push(`## ${labels.background}\n\n${input.notes.trim()}`)
  }
  for (const f of input.files) {
    parts.push(`## ${labels.contextFile}: ${f.path}\n\n${f.content.trim()}`)
  }
  parts.push(input.body.trim())
  return parts.join('\n\n---\n\n') + '\n'
}

/** Serialize a string array as an inline YAML array with quoted elements. */
function inlineArray(values: string[]): string {
  return `[${values.map(v => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ')}]`
}

/**
 * Add `fileRelPath` to a prompt document's `context-files` frontmatter list.
 * No-ops (returns the input unchanged) when there is no frontmatter or the path
 * is already bound. Only the `context-files` line is touched; all other content
 * and formatting is preserved.
 */
export function addContextFileToFrontmatter(content: string, fileRelPath: string): string {
  const path = fileRelPath.trim()
  if (!path) return content
  const { frontmatter, body } = extractFrontmatter(content)
  if (!frontmatter) return content

  const existing = parsePromptMeta(frontmatter).contextFiles
  if (existing.includes(path)) return content
  const next = [...existing, path]

  const lines = frontmatter.split('\n')
  let closeIdx = -1
  for (let i = lines.length - 1; i >= 1; i--) {
    if (lines[i].trim() === '---') { closeIdx = i; break }
  }
  if (closeIdx < 0) return content

  const serialized = `context-files: ${inlineArray(next)}`
  let replaced = false
  for (let i = 1; i < closeIdx; i++) {
    if (/^context-files:/.test(lines[i].trim())) { lines[i] = serialized; replaced = true; break }
  }
  if (!replaced) lines.splice(closeIdx, 0, serialized)

  return lines.join('\n') + body
}

/** Escape a string for a YAML double-quoted scalar (single physical line). */
function encodeDoubleQuoted(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
}

/**
 * Set (or, when `notes` is blank, remove) a prompt's `context-notes` frontmatter
 * field. Multi-line notes are stored on one physical line with `\n` escapes.
 * Only the `context-notes` line is touched. No-ops without frontmatter.
 */
export function setContextNotesInFrontmatter(content: string, notes: string): string {
  const { frontmatter, body } = extractFrontmatter(content)
  if (!frontmatter) return content

  const lines = frontmatter.split('\n')
  let closeIdx = -1
  for (let i = lines.length - 1; i >= 1; i--) {
    if (lines[i].trim() === '---') { closeIdx = i; break }
  }
  if (closeIdx < 0) return content

  const trimmed = notes.trim()
  let existingIdx = -1
  for (let i = 1; i < closeIdx; i++) {
    if (/^context-notes:/.test(lines[i].trim())) { existingIdx = i; break }
  }

  if (!trimmed) {
    // Remove the line if present.
    if (existingIdx >= 0) lines.splice(existingIdx, 1)
    return lines.join('\n') + body
  }

  const serialized = `context-notes: "${encodeDoubleQuoted(notes)}"`
  if (existingIdx >= 0) lines[existingIdx] = serialized
  else lines.splice(closeIdx, 0, serialized)
  return lines.join('\n') + body
}

/** Remove `fileRelPath` from a prompt's `context-files` list (unbind). */
export function removeContextFileFromFrontmatter(content: string, fileRelPath: string): string {
  const path = fileRelPath.trim()
  const { frontmatter, body } = extractFrontmatter(content)
  if (!frontmatter) return content

  const existing = parsePromptMeta(frontmatter).contextFiles
  if (!existing.includes(path)) return content
  const next = existing.filter(p => p !== path)

  const lines = frontmatter.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (/^context-files:/.test(lines[i].trim())) {
      lines[i] = `context-files: ${inlineArray(next)}`
      break
    }
  }
  return lines.join('\n') + body
}
