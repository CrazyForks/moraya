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

interface RawEntry {
  name: string
  path: string
  is_dir: boolean
}

/**
 * Load and parse every prompt asset under `{kbRoot}/prompts/`. Returns an empty
 * array when the directory does not exist yet. Unreadable files are skipped.
 */
export async function loadPromptDocs(kbRoot: string): Promise<PromptAssetDoc[]> {
  const dir = `${kbRoot}/${PROMPTS_DIR}`
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
      docs.push(parsePromptDoc(`${PROMPTS_DIR}/${f.name}`, content))
    } catch {
      // skip unreadable file
    }
  }
  return docs
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
