/**
 * Prompt-asset capture — Tauri-facing orchestration.
 *
 * Ties the pure transcript parser (transcript.ts) + document builder
 * (document.ts) + per-KB state (store.ts) to the Rust read-only transcript
 * commands and the KB file/sync layer. See docs/specs/prompt-asset.md §4.1.
 */
import { invoke } from '@tauri-apps/api/core'
import { PROMPTS_DIR, type ImportResult, type PromptCandidate, type SessionGroup, type TranscriptFile } from './types'
import { dedupe, extractCandidates } from './transcript'
import { baseFileName, buildPromptMarkdown, uniqueFileName } from './document'
import { getKbState, recordImport } from './store'

/** Result of scanning the bound Claude Code directory. */
export interface ScanResult {
  groups: SessionGroup[]
  /** Total candidates (across all groups), after dedupe + already-imported filter. */
  totalCandidates: number
  /** Highest transcript mtime seen this scan (advances the watermark on import). */
  scanMtime: number
  /** How many transcript files were considered. */
  transcriptsScanned: number
}

/** Enumerate Claude Code transcripts (Rust command). */
async function listTranscripts(claudeDir: string | null): Promise<TranscriptFile[]> {
  const rows = await invoke<TranscriptFile[]>('list_claude_transcripts', {
    claudeDir: claudeDir ?? null,
  })
  return rows
}

/** Read one transcript's raw JSONL (Rust command). */
async function readTranscript(path: string): Promise<string> {
  return invoke<string>('read_claude_transcript', { path })
}

/**
 * Scan the bound Claude Code directory for a KB and return grouped, deduped,
 * not-yet-imported prompt candidates.
 *
 * @param kbId          Target knowledge base id (for already-imported filtering).
 * @param opts.claudeDir Override root; null = default `~/.claude`.
 * @param opts.incremental When true, only read transcripts newer than the
 *        stored watermark (skips re-parsing the whole history on repeat scans).
 */
export async function scanClaudePrompts(
  kbId: string,
  opts: { claudeDir?: string | null; incremental?: boolean } = {},
): Promise<ScanResult> {
  const state = await getKbState(kbId)
  const claudeDir = opts.claudeDir ?? state.claudeDir ?? null
  const alreadyImported = new Set(state.importedKeys)

  const files = await listTranscripts(claudeDir)
  const watermark = opts.incremental ? state.lastScanMtime : 0
  const fresh = files.filter(f => f.mtime > watermark)

  let scanMtime = state.lastScanMtime
  const all: PromptCandidate[] = []
  for (const f of fresh) {
    if (f.mtime > scanMtime) scanMtime = f.mtime
    let jsonl: string
    try {
      jsonl = await readTranscript(f.path)
    } catch {
      continue // unreadable/oversized transcript — skip, don't fail the scan
    }
    all.push(...extractCandidates(jsonl, { sessionId: f.sessionId, dirName: f.dirName }))
  }

  const deduped = dedupe(all).filter(c => !alreadyImported.has(c.key))
  const groups = groupBySession(deduped)
  return {
    groups,
    totalCandidates: deduped.length,
    scanMtime,
    transcriptsScanned: fresh.length,
  }
}

/** Group candidates by session, newest session first. */
export function groupBySession(candidates: PromptCandidate[]): SessionGroup[] {
  const bySession = new Map<string, PromptCandidate[]>()
  for (const c of candidates) {
    const list = bySession.get(c.sessionId)
    if (list) list.push(c)
    else bySession.set(c.sessionId, [c])
  }
  const groups: SessionGroup[] = []
  for (const [sessionId, cands] of bySession) {
    cands.sort((a, b) => a.sentAt.localeCompare(b.sentAt))
    groups.push({
      sessionId,
      project: cands[0]?.project ?? 'unknown',
      latestAt: cands.reduce((m, c) => (c.sentAt > m ? c.sentAt : m), ''),
      candidates: cands,
    })
  }
  groups.sort((a, b) => b.latestAt.localeCompare(a.latestAt))
  return groups
}

/**
 * Write selected candidates into `{kbRoot}/prompts/*.md`, then record their
 * keys + advance the scan watermark for idempotent re-imports. Existing prompt
 * filenames seed collision avoidance so nothing is overwritten.
 *
 * @returns counts + relative paths of newly written files.
 */
export async function importCandidates(
  kbId: string,
  kbRoot: string,
  selected: PromptCandidate[],
  scanMtime: number,
): Promise<ImportResult> {
  if (selected.length === 0) {
    return { written: 0, skipped: 0, paths: [] }
  }

  const promptsDir = `${kbRoot}/${PROMPTS_DIR}`
  const taken = await existingPromptFileNames(promptsDir)

  const paths: string[] = []
  let written = 0
  let skipped = 0
  const keys: string[] = []
  for (const c of selected) {
    const name = uniqueFileName(baseFileName(c), taken)
    const abs = `${promptsDir}/${name}`
    try {
      await invoke('write_file', { path: abs, content: buildPromptMarkdown(c) })
      paths.push(`${PROMPTS_DIR}/${name}`)
      keys.push(c.key)
      written += 1
    } catch {
      skipped += 1
    }
  }

  await recordImport(kbId, keys, scanMtime)
  return { written, skipped, paths }
}

/** List existing `*.md` filenames under a KB's prompts/ dir (for collision seeds). */
async function existingPromptFileNames(promptsDir: string): Promise<Set<string>> {
  const taken = new Set<string>()
  try {
    const entries = await invoke<Array<{ name: string; is_dir: boolean }>>('read_dir_recursive', {
      path: promptsDir,
      depth: 1,
    })
    for (const e of entries) {
      if (!e.is_dir && e.name.endsWith('.md')) taken.add(e.name)
    }
  } catch {
    // prompts/ doesn't exist yet — write_file creates it.
  }
  return taken
}
