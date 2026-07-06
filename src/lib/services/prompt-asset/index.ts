/**
 * Prompt-asset capture — barrel export.
 * Recovers prompts sent to external AI tools (Claude Code) from local session
 * transcripts and saves them as visible Markdown assets under a KB's prompts/
 * directory. See docs/specs/prompt-asset.md.
 */
export {
  PROMPTS_DIR,
  type PromptSource,
  type DropReason,
  type PromptCandidate,
  type SessionGroup,
  type TranscriptFile,
  type ImportResult,
} from './types'

export {
  MIN_LIKELY_LEN,
  normalizeText,
  hashText,
  deriveProject,
  classify,
  isLikelyPrompt,
  extractCandidates,
  dedupe,
} from './transcript'

export {
  slugify,
  dateStamp,
  baseFileName,
  uniqueFileName,
  buildPromptMarkdown,
} from './document'

export {
  scanClaudePrompts,
  groupBySession,
  importCandidates,
  type ScanResult,
} from './import-service'

export {
  getKbState,
  setKbState,
  setClaudeDir,
  recordImport,
  setPromptAssetPersistence,
  type KbPromptState,
  type PromptAssetPersistence,
} from './store'

export {
  parsePromptMeta,
  parsePromptDoc,
  deriveTitle,
  scoreDoc,
  rankPrompts,
  bumpUsage,
  type PromptMeta,
  type PromptAssetDoc,
} from './prompt-index'

export {
  loadPromptDocs,
  markPromptUsed,
  toKbRelative,
  resolveContextFiles,
  assembleCard,
  bindContextFile,
} from './recall-service'

export {
  assemblePromptCard,
  addContextFileToFrontmatter,
  removeContextFileFromFrontmatter,
  type CardInput,
  type CardLabels,
} from './prompt-card'

export { promptToTemplate, templateIdForPrompt, PROMOTED_CATEGORY } from './refine'
export { promoteToTemplate, archivePrompt } from './refine-service'

export {
  findDuplicateGroups,
  duplicatePaths,
  groupFor,
  DEFAULT_DUP_THRESHOLD,
} from './dedup'
