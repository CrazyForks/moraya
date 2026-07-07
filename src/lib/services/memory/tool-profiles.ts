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
