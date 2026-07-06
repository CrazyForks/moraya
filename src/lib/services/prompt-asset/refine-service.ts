/**
 * Prompt-asset refine — Tauri-facing operations: promote a prompt to a KB
 * template (reusing the AI template storage) and archive cold prompts.
 * See docs/specs/prompt-asset.md §4.3.
 */
import { invoke } from '@tauri-apps/api/core'
import { saveTemplate } from '$lib/services/ai/templates/template-storage'
import { PROMPTS_DIR } from './types'
import { promptToTemplate, restoreTargetPath } from './refine'
import type { PromptAssetDoc } from './prompt-index'

/**
 * Promote a prompt asset into a reusable, KB-scoped AI template (appears in the
 * template gallery). Reuses `saveTemplate`, which strips runtime fields, writes
 * `{kbRoot}/templates/{id}.json`, and reloads the registry.
 */
export async function promoteToTemplate(doc: PromptAssetDoc): Promise<void> {
  await saveTemplate(promptToTemplate(doc), 'kb')
}

/**
 * Move a prompt into `prompts/archive/`. Archived prompts live in a nested
 * directory that `loadPromptDocs` does not descend into, so they drop out of
 * recall without being deleted. Returns the new KB-relative path, or null on
 * failure (e.g. a same-named file already archived).
 */
export async function archivePrompt(
  kbRoot: string,
  relativePath: string,
): Promise<string | null> {
  const base = relativePath.split('/').pop()
  if (!base) return null
  const archiveDir = `${kbRoot}/${PROMPTS_DIR}/archive`
  try {
    // create_dir errors when the dir already exists — that's fine.
    await invoke('create_dir', { path: archiveDir }).catch(() => {})
    await invoke('rename_file', {
      oldPath: `${kbRoot}/${relativePath}`,
      newPath: `${archiveDir}/${base}`,
    })
    return `${PROMPTS_DIR}/archive/${base}`
  } catch {
    return null
  }
}

/**
 * Restore an archived prompt (`prompts/archive/x.md`) back to `prompts/x.md`.
 * Returns the new KB-relative path, or null on failure (e.g. an active prompt
 * with the same name already exists).
 */
export async function restorePrompt(
  kbRoot: string,
  archiveRelPath: string,
): Promise<string | null> {
  const target = restoreTargetPath(archiveRelPath)
  try {
    await invoke('rename_file', {
      oldPath: `${kbRoot}/${archiveRelPath}`,
      newPath: `${kbRoot}/${target}`,
    })
    return target
  } catch {
    return null
  }
}
