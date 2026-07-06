/**
 * Prompt-asset refine — pure transforms for promoting a prompt asset into a
 * reusable AI template. See docs/specs/prompt-asset.md §4.3.
 */
import type { AITemplate } from '$lib/services/ai/templates/types'
import type { PromptAssetDoc } from './prompt-index'
import { PROMPTS_DIR } from './types'

/** Category id for prompts promoted into the template gallery. */
export const PROMOTED_CATEGORY = 'my_prompts'

/** KB-relative target when restoring an archived prompt back to `prompts/`.
 *  "prompts/archive/x.md" → "prompts/x.md". */
export function restoreTargetPath(archiveRelPath: string): string {
  const base = archiveRelPath.split('/').pop() ?? archiveRelPath
  return `${PROMPTS_DIR}/${base}`
}

/** Stable template id derived from the prompt file (keeps the date-slug stem). */
export function templateIdForPrompt(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath
  const stem = base.replace(/\.md$/, '')
  return `${PROMOTED_CATEGORY}.${stem}`
}

/**
 * Build an AITemplate from a prompt asset: a self-contained `auto`-flow prompt
 * (no editor content needed) whose body becomes the user prompt verbatim. The
 * caller persists it via the template-storage `saveTemplate(..., 'kb')`.
 */
export function promptToTemplate(doc: PromptAssetDoc): AITemplate {
  return {
    id: templateIdForPrompt(doc.relativePath),
    category: PROMOTED_CATEGORY,
    icon: '📝',
    name: doc.title,
    flow: 'auto',
    contentSource: 'none',
    systemPrompt: '',
    userPromptTemplate: doc.body,
    defaultActions: ['insert', 'copy'],
    tags: doc.meta.tags,
  }
}
