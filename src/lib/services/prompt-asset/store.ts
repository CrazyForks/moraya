/**
 * Prompt-asset per-KB persistence — a single Tauri plugin-store file
 * `prompt-asset.json`. Tracks, per knowledge base, the bound Claude Code
 * directory, the last incremental scan watermark, and the set of already-
 * imported candidate keys (so re-scans don't re-create duplicate files).
 *
 * The disk layer is injected via `setPromptAssetPersistence` so unit tests run
 * without a Tauri runtime; production wires the plugin-store adapter lazily.
 */

const STORE_FILE = 'prompt-asset.json'

export interface KbPromptState {
  /** Bound Claude Code root, or null to use the default `~/.claude`. */
  claudeDir: string | null
  /** Highest transcript mtime (secs) seen in a completed import — scan watermark. */
  lastScanMtime: number
  /** Candidate keys already written, so re-imports stay idempotent. */
  importedKeys: string[]
}

const DEFAULT_STATE: KbPromptState = { claudeDir: null, lastScanMtime: 0, importedKeys: [] }

export interface PromptAssetPersistence {
  read<T>(key: string): Promise<T | null>
  write(key: string, value: unknown): Promise<void>
}

const tauriPersistence: PromptAssetPersistence = {
  async read<T>(key: string): Promise<T | null> {
    const { load } = await import('@tauri-apps/plugin-store')
    const store = await load(STORE_FILE)
    return (await store.get<T>(key)) ?? null
  },
  async write(key: string, value: unknown): Promise<void> {
    const { load } = await import('@tauri-apps/plugin-store')
    const store = await load(STORE_FILE)
    await store.set(key, value)
    await store.save()
  },
}

let persistence: PromptAssetPersistence = tauriPersistence

/** Override the disk layer (tests). Pass null to restore the Tauri adapter. */
export function setPromptAssetPersistence(p: PromptAssetPersistence | null): void {
  persistence = p ?? tauriPersistence
}

function keyFor(kbId: string): string {
  return `kb:${kbId}`
}

export async function getKbState(kbId: string): Promise<KbPromptState> {
  const v = await persistence.read<KbPromptState>(keyFor(kbId))
  return v ? { ...DEFAULT_STATE, ...v } : { ...DEFAULT_STATE }
}

export async function setKbState(kbId: string, state: KbPromptState): Promise<void> {
  await persistence.write(keyFor(kbId), state)
}

/** Record newly imported keys + advance the scan watermark, merging with prior state. */
export async function recordImport(
  kbId: string,
  newKeys: string[],
  scanMtime: number,
): Promise<void> {
  const prev = await getKbState(kbId)
  const merged = new Set([...prev.importedKeys, ...newKeys])
  await setKbState(kbId, {
    claudeDir: prev.claudeDir,
    lastScanMtime: Math.max(prev.lastScanMtime, scanMtime),
    importedKeys: [...merged],
  })
}

export async function setClaudeDir(kbId: string, claudeDir: string | null): Promise<void> {
  const prev = await getKbState(kbId)
  await setKbState(kbId, { ...prev, claudeDir })
}
