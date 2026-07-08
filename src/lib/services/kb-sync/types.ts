export type SyncMode = 'manual' | 'on-save' | 'interval' | 'on-startup-and-close';
export type SyncScope = 'markdown-only' | 'markdown-plus-rules' | 'all-including-hidden';
export type ConflictPolicy = 'prompt' | 'prefer-local' | 'prefer-remote';

export interface SyncStrategy {
  mode: SyncMode;
  intervalSecs: 60 | 300 | 900 | 1800;
  scope: SyncScope;
  excludePatterns: string[];
  conflictPolicy: ConflictPolicy;
  maxFileSizeBytes: number;
}

export const DEFAULT_SYNC_STRATEGY: SyncStrategy = {
  mode: 'on-save',
  intervalSecs: 300,
  scope: 'all-including-hidden',
  excludePatterns: ['node_modules/**', '.git/**', '.DS_Store', '*.tmp', '.env*', '*.key', '*.pem'],
  conflictPolicy: 'prompt',
  maxFileSizeBytes: 2 * 1024 * 1024,
};

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  deletedRemote: number;
  deletedLocal: number;
  skipped: number;
  conflicts: number;
}

export interface KbBinding {
  localKbId: string;
  picoraTargetId: string;
  picoraKbId: string;
  picoraKbName: string;
  strategy: SyncStrategy;
  lastSyncAt: string | null;
  lastSyncReport: SyncReport | null;
  lastSyncError: string | null;
}

// Picora API types

export interface PicoraKb {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  docCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManifestEntry {
  relativePath: string;
  sourceHash: string;
  sizeBytes: number;
  updatedAt: string;
}

export type SyncOpType = 'upsert' | 'delete';

export interface SyncOp {
  op: SyncOpType;
  relativePath: string;
  content?: string;
  sourceHash?: string;
  baseUpdatedAt?: string;
}

export interface SyncBatchResult {
  applied: string[];
  conflicts: ConflictEntry[];
}

export interface ConflictEntry {
  relativePath: string;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  localSizeBytes: number;
  remoteSizeBytes: number;
  localPreview: string;
  remotePreview: string;
  localHash: string;
  remoteHash: string;
  /** Full local file content (for line-level merge in the resolution UI). */
  localContent: string;
  /** Full remote file content. */
  remoteContent: string;
  /** Last-synced common ancestor content, or null if no merge base is known
   *  (e.g. first sync, or file predates base-content caching). */
  baseContent: string | null;
}

export type ConflictResolution = 'prefer-local' | 'prefer-remote' | 'keep-both';

// ── Line-level merge (git-style) ─────────────────────────────────────

/** One region of a line-level merge. `stable` regions are agreed-upon lines;
 *  `conflict` regions carry the diverging local/remote (and base) line arrays. */
export interface MergeChunk {
  type: 'stable' | 'conflict';
  /** For stable chunks: the agreed lines. */
  lines?: string[];
  /** For conflict chunks: local side ("mine"). */
  local?: string[];
  /** For conflict chunks: remote side ("theirs"). */
  remote?: string[];
  /** For conflict chunks: base side (common ancestor); absent when no base. */
  base?: string[];
}

export interface MergeResult {
  chunks: MergeChunk[];
  hasConflict: boolean;
  /** Fully auto-merged text when `hasConflict` is false; otherwise null. */
  mergedText: string | null;
}

/** Per-conflict-chunk pick in the resolution UI. */
export type ChunkPick = 'local' | 'remote' | 'both-local-first' | 'both-remote-first';

// Local manifest for three-way diff

export interface LocalManifestEntry {
  relativePath: string;
  sourceHash: string;
  sizeBytes: number;
  mtime: number;
}

export type LocalManifest = Map<string, LocalManifestEntry>;
export type RemoteManifest = Map<string, ManifestEntry>;

// Diff result

export type DiffAction =
  | { kind: 'upload'; relativePath: string }
  | { kind: 'download'; relativePath: string }
  | { kind: 'delete-remote'; relativePath: string }
  | { kind: 'delete-local'; relativePath: string }
  | { kind: 'conflict'; relativePath: string }
  | { kind: 'skip-large'; relativePath: string; sizeBytes: number }
  | { kind: 'aligned' };

export interface DiffResult {
  actions: DiffAction[];
  uploadPaths: string[];
  downloadPaths: string[];
  deleteRemotePaths: string[];
  deleteLocalPaths: string[];
  conflictPaths: string[];
  skippedLarge: Array<{ relativePath: string; sizeBytes: number }>;
}

// Sync state per KB (for UI reactivity)

export type KbSyncStatus = 'unbound' | 'idle' | 'syncing' | 'conflict' | 'error';

export interface KbSyncState {
  localKbId: string;
  status: KbSyncStatus;
  conflictCount: number;
  pendingConflicts: ConflictEntry[];
  lastError: string | null;
}
