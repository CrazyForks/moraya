/**
 * Per-tool memory profiles (Picora 点目录架构设计 §4).
 *
 * Each AI tool's local memory directory is bound into a KB namespace via a
 * profile: `{ defaultRoot, mountAs, include, exclude }`. `exclude` items are a
 * SECURITY HARD-LINE (transcripts, tokens, runtime noise) — always applied,
 * never user-removable, so a binding can't accidentally upload secrets.
 *
 * Pure module: glob → RegExp matching, no I/O.
 */

export interface ToolProfile {
  /** Profile key, also the tool identifier. */
  tool: string
  /** Default local memory root (may start with `~`). */
  defaultRoot: string
  /** KB namespace the memory mounts as (dot-directory). */
  mountAs: string
  /** Relative-path globs to sync (a file must match at least one). */
  include: string[]
  /** Relative-path globs to NEVER sync (hard exclude; wins over include). */
  exclude: string[]
}

/**
 * First-party profiles. `claude` per the design's sensitivity audit; `moraya`
 * is the built-in full binding for Moraya's own memory.
 */
export const TOOL_PROFILES: Record<string, ToolProfile> = {
  claude: {
    tool: 'claude',
    defaultRoot: '~/.claude',
    mountAs: '.claude',
    include: ['projects/*/memory/**', 'CLAUDE.md', 'agents/**', 'skills/**'],
    exclude: ['**/*.jsonl', 'settings*.json', 'shell-snapshots/**', 'todos/**', 'plans/**', 'statsig/**'],
  },
  moraya: {
    tool: 'moraya',
    defaultRoot: '~/.moraya',
    mountAs: '.moraya',
    include: ['**'],
    exclude: [],
  },
  // Conservative starting template for Codex CLI (~/.codex). Include the
  // memory/instruction assets; hard-exclude transcripts, config, and anything
  // that could carry credentials. Refine as the layout is audited.
  codex: {
    tool: 'codex',
    defaultRoot: '~/.codex',
    mountAs: '.codex',
    include: ['AGENTS.md', 'memory/**', 'instructions*.md', 'prompts/**'],
    exclude: ['**/*.jsonl', '**/*.json', 'auth*', 'sessions/**', 'logs/**', 'history*', '.git/**'],
  },
}

/** First-party external tool profiles that can be bound (excludes built-in moraya). */
export const EXTERNAL_TOOLS: readonly string[] = ['claude', 'codex']

export function getToolProfile(tool: string): ToolProfile | null {
  return TOOL_PROFILES[tool] ?? null
}

/**
 * A materialized binding = a profile pinned to a concrete local path. Stored in
 * the client-local binding table (never uploaded; contains machine paths).
 */
export interface MemoryBinding {
  tool: string
  externalPath: string // concrete local dir (may start with `~`)
  mountAs: string
  include: string[]
  exclude: string[]
  /**
   * Tier 2 (Picora 设计 §12): route this tool's memory to a dedicated KB. When
   * unset, it syncs to the shared "AI Memory" KB (Tier 1).
   */
  kbId?: string
  /**
   * ISO 8601 timestamp of the last successful cloud backup of this binding.
   * `undefined` = never synced. Recorded by `syncBinding()` and shown in the
   * memory-asset panel so the user can tell whether/when it reached the cloud.
   */
  lastSyncedAt?: string
}

/** Build a binding from a profile. Hard-excludes are always taken from the profile. */
export function bindingFromProfile(profile: ToolProfile, externalPath?: string): MemoryBinding {
  return {
    tool: profile.tool,
    externalPath: externalPath ?? profile.defaultRoot,
    mountAs: profile.mountAs,
    include: [...profile.include],
    exclude: [...profile.exclude],
  }
}

/**
 * Safe hard-excludes applied to user-added custom memory directories (no tool
 * profile). Blocks transcripts, credentials, VCS/build noise so a hand-picked
 * dir can't leak secrets on backup.
 */
export const CUSTOM_BINDING_EXCLUDES: readonly string[] = [
  '**/*.jsonl', '**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx',
  '**/.env', '**/.env.*', '**/id_rsa*', '**/*.log',
  '**/node_modules/**', '**/.git/**', '**/.DS_Store',
]

/**
 * Common `~/`-level hidden directories that are NOT AI memory: OS caches/junk,
 * secret stores, and language/build toolchains. Excluded from the memory-dir
 * scan so the picker surfaces AI tool dirs (`.claude`, `.cursor`, `.aider`…),
 * not system noise — and never suggests a secret store like `.ssh`/`.gnupg`.
 * Cross-platform (macOS / Linux / Windows home).
 */
export const SYSTEM_HIDDEN_DIRS: ReadonlySet<string> = new Set([
  // OS / desktop / shell junk
  '.Trash', '.trash', '.cache', '.config', '.local', '.CFUserTextEncoding',
  '.cups', '.zsh_sessions', '.bash_sessions', '.fontconfig', '.thumbnails',
  '.dbus', '.gnome', '.gnome2', '.kde', '.mono', '.pki', '.recently-used',
  // secret / credential stores — never suggest (avoid accidental backup)
  '.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.gcloud', '.kube', '.docker',
  '.password-store', '.netrc',
  // language / build / package toolchains
  '.npm', '.node-gyp', '.nvm', '.yarn', '.pnpm-store', '.cargo', '.rustup',
  '.gradle', '.m2', '.gem', '.bundle', '.pyenv', '.rbenv', '.rvm', '.conda',
  '.android', '.dotnet', '.nuget', '.deno', '.bun', '.go', '.cabal', '.stack',
  // editors / vcs / browser noise
  '.oh-my-zsh', '.vim', '.viminfo', '.emacs.d', '.vscode', '.vscode-server',
  '.idea', '.git', '.subversion', '.hg', '.mozilla', '.thunderbird',
])

/**
 * True iff `name` is a hidden directory worth suggesting as an AI memory dir:
 * dot-prefixed, not `.`/`..`, not `.moraya` (the KB's own namespace, synced
 * with the folder), and not a known system/secret/toolchain dir.
 */
export function isSuggestableHiddenDir(name: string): boolean {
  if (!name.startsWith('.') || name === '.' || name === '..') return false
  if (name === '.moraya') return false
  return !SYSTEM_HIDDEN_DIRS.has(name)
}

/** Turn a directory basename into a valid dot-namespace (`.name`). */
export function mountAsFromDirName(name: string): string {
  const clean = name.replace(/^\.+/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return '.' + (clean || 'memory')
}

/** Build a binding for a user-picked custom directory (generic full-sync profile). */
export function customBinding(externalPath: string, mountAs: string, kbId?: string): MemoryBinding {
  const b: MemoryBinding = {
    tool: 'custom',
    externalPath,
    mountAs: mountAs.startsWith('.') ? mountAs : '.' + mountAs,
    include: ['**'],
    exclude: [...CUSTOM_BINDING_EXCLUDES],
  }
  if (kbId) b.kbId = kbId
  return b
}

// ── Glob matching ────────────────────────────────────────────────────────────

const REGEX_SPECIAL = new Set(['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

/**
 * Compile a POSIX-ish glob into a RegExp. Supports:
 *   `**`  — any number of path segments (incl. none)
 *   `*`   — any run of non-`/` chars within a segment
 *   literal chars (regex-escaped)
 */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2
        if (glob[i] === '/') { re += '(?:.*/)?'; i++ } // `**/` → optional leading dirs
        else re += '.*'                                 // `**` → anything
      } else {
        re += '[^/]*'
        i++
      }
    } else if (REGEX_SPECIAL.has(c)) {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  return new RegExp('^' + re + '$')
}

const regexCache = new Map<string, RegExp>()
function cachedRegex(glob: string): RegExp {
  let r = regexCache.get(glob)
  if (!r) { r = globToRegExp(glob); regexCache.set(glob, r) }
  return r
}

/** True if `relPath` matches any of the globs. Empty list → false. */
export function matchesAnyGlob(relPath: string, globs: string[]): boolean {
  return globs.some(g => cachedRegex(g).test(relPath))
}

/** A file is synced iff it matches an include glob AND no exclude glob. */
export function includedByProfile(
  relPath: string,
  profile: Pick<ToolProfile, 'include' | 'exclude'>,
): boolean {
  if (matchesAnyGlob(relPath, profile.exclude)) return false
  return matchesAnyGlob(relPath, profile.include)
}
