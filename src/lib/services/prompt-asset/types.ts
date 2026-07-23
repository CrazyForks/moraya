/**
 * Prompt-asset capture — shared types.
 *
 * A "prompt asset" is a natural-language prompt the user sent to an external AI
 * tool (Claude Code first), recovered from that tool's local session transcript
 * and saved as a visible Markdown document under a knowledge base's `prompts/`
 * directory. See docs/specs/prompt-asset.md.
 */

/** Directory (relative to a KB root) prompt assets are written into. */
export const PROMPTS_DIR = 'prompts'

/** External tool a prompt was captured from. Extensible; P1 = claude-code. */
export type PromptSource = 'claude-code' | 'moraya' | 'manual'

/**
 * Why a transcript line was rejected as *not* a user prompt. `null`/absent
 * means the line is a genuine user message and becomes a candidate.
 */
export type DropReason =
  | 'not-user' // not a `type:"user"` entry
  | 'tool-result' // user turn carrying a tool_result block, not typed text
  | 'empty' // no extractable text
  | 'meta' // isMeta — tool/system injected (e.g. "[Image: …]")
  | 'sidechain' // isSidechain — sub-agent internal turn, not the human
  | 'system-tag' // system-injected wrapper (<task-notification>, <system-reminder>, …)
  | 'slash-command' // slash-command echo (<command-name>, <local-command-stdout>, …)

/** A genuine user message extracted from a transcript. */
export interface PromptCandidate {
  /** Stable dedupe/selection key = hash of sessionId + normalized text. */
  key: string
  /** Source session id (transcript file stem or the entry's sessionId). */
  sessionId: string
  /** Human-facing project label (cwd basename, else decoded dir name). */
  project: string
  /** ISO timestamp the prompt was sent. */
  sentAt: string
  /** Prompt text, preserved verbatim (never rewritten). */
  text: string
  /**
   * Default selection state in the import preview: true when the message looks
   * like a real requirement prompt (not a short confirmation). Short/ambiguous
   * messages are still offered as candidates but unchecked by default.
   */
  likely: boolean
}

/** Candidates grouped by session for the preview panel. */
export interface SessionGroup {
  sessionId: string
  project: string
  /** Most recent prompt time in the session (ISO), for sorting. */
  latestAt: string
  candidates: PromptCandidate[]
}

/** A transcript file discovered under the external tool's directory. */
export interface TranscriptFile {
  /** Absolute path to the `.jsonl` transcript. */
  path: string
  /** Encoded project directory name (e.g. "-Users-me-Documents-app"). */
  dirName: string
  /** Session id = transcript file stem. */
  sessionId: string
  /** Modification time, seconds since epoch (for incremental scans). */
  mtime: number
}

/** Outcome of writing selected candidates into a KB. */
export interface ImportResult {
  written: number
  skipped: number
  /** Relative paths (from KB root) of newly written files. */
  paths: string[]
}
