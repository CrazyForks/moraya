/**
 * Prompt-asset recall — Tauri-facing loader + usage writer.
 *
 * Loads the prompt documents captured under `{kbRoot}/prompts/` and, on use,
 * bumps their usage metadata in place. Ranking/parsing is the pure logic in
 * `prompt-index.ts`. See docs/specs/prompt-asset.md §4.2.
 */
import { invoke } from '@tauri-apps/api/core'
import { PROMPTS_DIR } from './types'
import { parsePromptDoc, bumpUsage, type PromptAssetDoc } from './prompt-index'
import {
  assemblePromptCard,
  addContextFileToFrontmatter,
  removeContextFileFromFrontmatter,
  setContextNotesInFrontmatter,
  type CardLabels,
} from './prompt-card'

interface RawEntry {
  name: string
  path: string
  is_dir: boolean
}

/** Load + parse every `.md` directly under `dir`, labelling each with
 *  `{relPrefix}/{name}`. Empty array when the dir is absent; skips bad files. */
async function loadDocsFromDir(dir: string, relPrefix: string): Promise<PromptAssetDoc[]> {
  let entries: RawEntry[]
  try {
    entries = await invoke<RawEntry[]>('read_dir_recursive', { path: dir, depth: 1 })
  } catch {
    return []
  }
  const files = entries.filter(e => !e.is_dir && e.name.endsWith('.md'))
  const docs: PromptAssetDoc[] = []
  for (const f of files) {
    try {
      const content = await invoke<string>('read_file', { path: f.path })
      docs.push(parsePromptDoc(`${relPrefix}/${f.name}`, content))
    } catch {
      // skip unreadable file
    }
  }
  return docs
}

/**
 * Load and parse the active prompt assets under `{kbRoot}/prompts/` (the nested
 * `archive/` subdir is not descended into, so archived prompts are excluded).
 */
export async function loadPromptDocs(kbRoot: string): Promise<PromptAssetDoc[]> {
  return loadDocsFromDir(`${kbRoot}/${PROMPTS_DIR}`, PROMPTS_DIR)
}

/** Load the archived prompts under `{kbRoot}/prompts/archive/`. */
export async function loadArchivedDocs(kbRoot: string): Promise<PromptAssetDoc[]> {
  return loadDocsFromDir(`${kbRoot}/${PROMPTS_DIR}/archive`, `${PROMPTS_DIR}/archive`)
}

/**
 * Record a use of a prompt: read the file, increment `usage-count` + set
 * `last-used`, and write it back. Best-effort — resolves even on failure so a
 * copy/insert action is never blocked by a metadata write.
 */
export async function markPromptUsed(
  kbRoot: string,
  relativePath: string,
  nowIso: string,
): Promise<void> {
  const abs = `${kbRoot}/${relativePath}`
  try {
    const content = await invoke<string>('read_file', { path: abs })
    const next = bumpUsage(content, nowIso)
    if (next !== content) await invoke('write_file', { path: abs, content: next })
  } catch {
    // non-fatal
  }
}

/** Convert an absolute path under `kbRoot` to a KB-relative path, or null if
 *  the file lives outside the KB. */
export function toKbRelative(kbRoot: string, absPath: string): string | null {
  const root = kbRoot.endsWith('/') ? kbRoot : `${kbRoot}/`
  if (!absPath.startsWith(root)) return null
  return absPath.slice(root.length)
}

/** Read the bound context files (KB-relative), skipping any that are unreadable. */
export async function resolveContextFiles(
  kbRoot: string,
  relPaths: string[],
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = []
  for (const rel of relPaths) {
    try {
      const content = await invoke<string>('read_file', { path: `${kbRoot}/${rel}` })
      out.push({ path: rel, content })
    } catch {
      // missing/unreadable context file — skip it
    }
  }
  return out
}

/**
 * Assemble a prompt's full "card": its background note + bound context files +
 * the prompt body, ready to paste into a fresh AI session.
 */
export async function assembleCard(
  kbRoot: string,
  doc: PromptAssetDoc,
  labels: CardLabels,
): Promise<string> {
  const files = await resolveContextFiles(kbRoot, doc.meta.contextFiles)
  return assemblePromptCard(
    { body: doc.body, notes: doc.meta.contextNotes, files },
    labels,
  )
}

/**
 * Bind a file (absolute path, must live under the KB) as environment context
 * for a prompt. Returns the new KB-relative path on success, or null if the
 * file is outside the KB / already bound / the write failed.
 */
export async function bindContextFile(
  kbRoot: string,
  promptRelPath: string,
  absFilePath: string,
): Promise<string | null> {
  const rel = toKbRelative(kbRoot, absFilePath)
  if (!rel) return null
  const abs = `${kbRoot}/${promptRelPath}`
  try {
    const content = await invoke<string>('read_file', { path: abs })
    const next = addContextFileToFrontmatter(content, rel)
    if (next === content) return null // already bound
    await invoke('write_file', { path: abs, content: next })
    return rel
  } catch {
    return null
  }
}

/** Set (or clear, when blank) a prompt's `context-notes` background field.
 *  Returns true on a successful write, false if unchanged or the write failed. */
export async function setContextNotes(
  kbRoot: string,
  promptRelPath: string,
  notes: string,
): Promise<boolean> {
  const abs = `${kbRoot}/${promptRelPath}`
  try {
    const content = await invoke<string>('read_file', { path: abs })
    const next = setContextNotesInFrontmatter(content, notes)
    if (next === content) return false
    await invoke('write_file', { path: abs, content: next })
    return true
  } catch {
    return false
  }
}

/** Remove a bound context file (KB-relative) from a prompt. Returns true on a
 *  successful write, false if it wasn't bound or the write failed. */
export async function unbindContextFile(
  kbRoot: string,
  promptRelPath: string,
  fileRel: string,
): Promise<boolean> {
  const abs = `${kbRoot}/${promptRelPath}`
  try {
    const content = await invoke<string>('read_file', { path: abs })
    const next = removeContextFileFromFrontmatter(content, fileRel)
    if (next === content) return false
    await invoke('write_file', { path: abs, content: next })
    return true
  } catch {
    return false
  }
}
