/**
 * Smart Rules Engine — v0.21.0
 *
 * Automatically splits MORAYA.md into indexed segments stored in .moraya/rules/.
 * System prompt receives a compact index instead of full content.
 * Glob-annotated sections auto-inject when editing matching files.
 */

import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One split section from MORAYA.md */
export interface RuleSection {
  /** 0 = preamble, 1+ = heading sections */
  index: number;
  /** Original heading text (empty for preamble) */
  title: string;
  /** Filename in .moraya/rules/ */
  filename: string;
  /** Full section content (heading + body + sub-headings) */
  content: string;
  /** Glob patterns from <!-- globs: ... --> */
  globs: string[];
  /** First 80 chars of body text */
  summary: string;
}

/** Index manifest stored as _index.json */
export interface RulesIndex {
  sourceHash: number;
  splitAt: number;
  count: number;
  sections: Array<{
    index: number;
    title: string;
    filename: string;
    globs: string[];
    summary: string;
  }>;
}

/** Result passed to buildSystemPrompt */
export interface RulesResult {
  index: RulesIndex;
  /** Sections whose globs matched the current file (auto-injected) */
  injectedSections: RuleSection[];
  /** Base path: {sidebarDir}/.moraya/rules/ */
  rulesDir: string;
  active: boolean;
  sectionCount: number;
  /** True if MORAYA.md has no headings */
  degraded: boolean;
  /** Preamble content if exists */
  preambleContent: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** DJB2 hash — fast, good distribution for text content. */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** Convert heading title to kebab-case filename slug. */
function slugify(title: string, index: number): string {
  // Strip HTML comments (glob annotations)
  const clean = title.replace(/<!--.*?-->/g, '').trim();
  // Try ASCII-friendly slug
  const slug = clean
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const nn = String(index).padStart(2, '0');
  return slug ? `section-${nn}-${slug}.md` : `section-${nn}.md`;
}

/** Parse <!-- globs: pat1, pat2 --> from a heading line. */
function parseGlobs(line: string): string[] {
  const m = line.match(/<!--\s*globs:\s*(.*?)\s*-->/i);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

/** Extract summary: first 80 chars of body text (skip heading and blank lines). */
function extractSummary(content: string, headingLine: string): string {
  const body = content
    .replace(headingLine, '')
    .replace(/<!--.*?-->/g, '')
    .trim();
  if (!body) return '';
  // Take first 80 chars without cutting mid-word
  if (body.length <= 80) return body.replace(/\n/g, ' ');
  const cut = body.slice(0, 80);
  const lastSpace = cut.lastIndexOf(' ');
  const summary = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
  return summary.replace(/\n/g, ' ') + '...';
}

/**
 * Lightweight glob pattern matching.
 * Supports: *, **, ?, and literal characters.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  // If pattern has no path separators, match against filename only
  const target = pattern.includes('/')
    ? filePath
    : filePath.split('/').pop() || filePath;

  // Convert glob to regex
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regex += '(?:.+/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        regex += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      regex += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }

  try {
    return new RegExp('^' + regex + '$').test(target);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

interface HeadingInfo {
  level: number;
  title: string;
  line: string;
  lineIndex: number;
}

/**
 * Parse MORAYA.md content into sections.
 * Splits by the dominant heading level, preserving sub-headings within each section.
 */
export function splitMorayaMd(content: string): RuleSection[] {
  const lines = content.split('\n');

  // Scan all headings, skipping those inside fenced code blocks
  const headings: HeadingInfo[] = [];
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    // Track fenced code block boundaries (``` or ~~~)
    if (/^(`{3,}|~{3,})/.test(lines[i].trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const m = lines[i].match(/^(#{1,6})\s+(.*)/);
    if (m) {
      headings.push({
        level: m[1].length,
        title: m[2],
        line: lines[i],
        lineIndex: i,
      });
    }
  }

  // No headings → degraded mode
  if (headings.length === 0) {
    return [{
      index: 0,
      title: '',
      filename: '_preamble.md',
      content: content,
      globs: [],
      summary: extractSummary(content, ''),
    }];
  }

  // Determine split level
  const minLevel = Math.min(...headings.map(h => h.level));
  const minLevelCount = headings.filter(h => h.level === minLevel).length;
  const nextLevelCount = headings.filter(h => h.level === minLevel + 1).length;

  let splitLevel: number;
  if (minLevelCount === 1) {
    // Single title heading → bump to next level
    splitLevel = minLevel + 1;
  } else if (nextLevelCount > minLevelCount) {
    // More headings at next level → those are the real structure
    // (handles cases like template `# {title}` mixed with a document H1)
    splitLevel = minLevel + 1;
  } else {
    splitLevel = minLevel;
  }

  // If no headings at the chosen level, fall back
  const splitHeadings = headings.filter(h => h.level === splitLevel);
  if (splitHeadings.length === 0) {
    splitLevel = minLevel;
  }

  const finalSplitHeadings = headings.filter(h => h.level === splitLevel);

  // Build sections
  const sections: RuleSection[] = [];
  let sectionIndex = 0;

  // Preamble: content before first split heading
  const firstSplitLine = finalSplitHeadings[0].lineIndex;
  if (firstSplitLine > 0) {
    const preambleContent = lines.slice(0, firstSplitLine).join('\n').trim();
    if (preambleContent) {
      sections.push({
        index: sectionIndex++,
        title: '',
        filename: '_preamble.md',
        content: preambleContent,
        globs: [],
        summary: extractSummary(preambleContent, ''),
      });
    }
  }

  // Split sections
  for (let i = 0; i < finalSplitHeadings.length; i++) {
    const heading = finalSplitHeadings[i];
    const startLine = heading.lineIndex;
    const endLine = i + 1 < finalSplitHeadings.length
      ? finalSplitHeadings[i + 1].lineIndex
      : lines.length;

    const sectionContent = lines.slice(startLine, endLine).join('\n').trimEnd();
    const globs = parseGlobs(heading.line);
    const titleClean = heading.title.replace(/<!--.*?-->/g, '').trim();

    sections.push({
      index: sectionIndex,
      title: titleClean,
      filename: slugify(titleClean, sectionIndex),
      content: sectionContent,
      globs,
      summary: extractSummary(sectionContent, heading.line),
    });
    sectionIndex++;
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Loading & Caching
// ---------------------------------------------------------------------------

/** In-memory cache to avoid reading _index.json on every message when hash matches. */
let cachedIndex: RulesIndex | null = null;
let cachedSections: RuleSection[] | null = null;
let cachedSidebarDir: string | null = null;

/**
 * Main entry point. Called from sendChatMessage() instead of readMorayaMd().
 *
 * 1. Read MORAYA.md — null if missing/empty
 * 2. DJB2 hash → compare with .moraya/hash
 * 3. Hash mismatch → split → write .moraya/rules/ + _index.json + hash
 * 4. Glob-match sections against currentFilePath
 * 5. Return RulesResult
 */
export async function loadRules(
  sidebarDir: string | null,
  currentFilePath: string | null,
): Promise<RulesResult | null> {
  if (!sidebarDir) return null;

  // 1. Read MORAYA.md
  let morayaContent: string;
  try {
    const content = await invoke<string>('read_file', {
      path: `${sidebarDir}/MORAYA.md`,
    });
    if (!content?.trim()) return null;
    morayaContent = content;
  } catch {
    return null;
  }

  // 2. Compute hash
  const hash = djb2(morayaContent);
  const rulesDir = `${sidebarDir}/.moraya/rules`;
  const hashPath = `${sidebarDir}/.moraya/hash`;
  const indexPath = `${rulesDir}/_index.json`;

  // 3. Check cache (in-memory first, then disk)
  let needsSplit = true;

  if (cachedIndex && cachedSidebarDir === sidebarDir && cachedIndex.sourceHash === hash && cachedSections) {
    needsSplit = false;
  } else {
    try {
      const storedHash = await invoke<string>('read_file', { path: hashPath });
      if (storedHash?.trim() === String(hash)) {
        // Disk cache valid — read index
        try {
          const indexJson = await invoke<string>('read_file', { path: indexPath });
          if (indexJson) {
            cachedIndex = JSON.parse(indexJson) as RulesIndex;
            cachedSidebarDir = sidebarDir;
            cachedSections = null; // sections read on demand
            needsSplit = false;
          }
        } catch {
          needsSplit = true;
        }
      }
    } catch {
      // hash file doesn't exist → need split
    }
  }

  // 4. Split if needed
  let sections: RuleSection[];
  if (needsSplit) {
    sections = splitMorayaMd(morayaContent);

    // Clean up old rules directory to prevent stale file pollution.
    // When MORAYA.md is fully rewritten, old section files must not remain.
    try {
      await invoke('delete_file', { path: rulesDir });
    } catch { /* directory may not exist yet */ }

    // Write section files (write_file creates parent dirs automatically)
    for (const section of sections) {
      await invoke('write_file', {
        path: `${rulesDir}/${section.filename}`,
        content: section.content,
      });
    }

    // Build and write index
    const index: RulesIndex = {
      sourceHash: hash,
      splitAt: Date.now(),
      count: sections.length,
      sections: sections.map(s => ({
        index: s.index,
        title: s.title,
        filename: s.filename,
        globs: s.globs,
        summary: s.summary,
      })),
    };

    await invoke('write_file', {
      path: indexPath,
      content: JSON.stringify(index, null, 2),
    });

    // Write hash
    await invoke('write_file', {
      path: hashPath,
      content: String(hash),
    });

    // Update in-memory cache
    cachedIndex = index;
    cachedSections = sections;
    cachedSidebarDir = sidebarDir;
  } else {
    // Use cached sections or read from disk as needed
    sections = cachedSections || [];
  }

  const index = cachedIndex!;
  const degraded = index.count === 1 && index.sections[0]?.title === '';

  // 5. Glob matching — find sections to auto-inject
  const injectedSections: RuleSection[] = [];
  if (currentFilePath) {
    const relativePath = currentFilePath.startsWith(sidebarDir + '/')
      ? currentFilePath.slice(sidebarDir.length + 1)
      : currentFilePath;

    for (const meta of index.sections) {
      if (meta.globs.length === 0) continue;
      const matched = meta.globs.some(g => matchGlob(g, relativePath));
      if (!matched) continue;

      // Read section content
      const existing = sections.find(s => s.filename === meta.filename);
      if (existing) {
        injectedSections.push(existing);
      } else {
        try {
          const content = await invoke<string>('read_file', {
            path: `${rulesDir}/${meta.filename}`,
          });
          if (content) {
            injectedSections.push({
              index: meta.index,
              title: meta.title,
              filename: meta.filename,
              content,
              globs: meta.globs,
              summary: meta.summary,
            });
          }
        } catch { /* skip */ }
      }
    }
  }

  // Preamble content
  let preambleContent: string | null = null;
  if (index.sections[0]?.title === '' && index.sections[0]?.filename === '_preamble.md') {
    const existing = sections.find(s => s.filename === '_preamble.md');
    if (existing) {
      preambleContent = existing.content;
    } else {
      try {
        preambleContent = await invoke<string>('read_file', {
          path: `${rulesDir}/_preamble.md`,
        });
      } catch { /* skip */ }
    }
  }

  return {
    index,
    injectedSections,
    rulesDir,
    active: true,
    sectionCount: index.count,
    degraded,
    preambleContent,
  };
}

// ---------------------------------------------------------------------------
// System Prompt Building
// ---------------------------------------------------------------------------

/**
 * Build the rules portion of the system prompt.
 */
export function buildRulesPrompt(result: RulesResult, sidebarDir: string): string {
  // Degraded mode: inject full content directly (like old behavior)
  if (result.degraded && result.preambleContent) {
    return '=== MANDATORY — Knowledge Base Rules (MORAYA.md) ===\n' +
      'The user has defined the following rules for ALL content in this knowledge base.\n' +
      'You MUST follow EVERY rule below precisely when generating content.\n\n' +
      result.preambleContent +
      '\n=== END MANDATORY RULES ===';
  }

  let prompt = '=== Knowledge Base Rules (MORAYA.md) ===\n' +
    `The knowledge base has ${result.sectionCount} indexed rule sections.\n` +
    'You MUST read and follow the relevant rule sections before generating content.\n';

  // Preamble (always injected if exists)
  if (result.preambleContent) {
    prompt += '\n' + result.preambleContent + '\n';
  }

  // Auto-injected glob-matched sections
  if (result.injectedSections.length > 0) {
    prompt += '\n[Auto-injected rules for current file]\n';
    for (const section of result.injectedSections) {
      prompt += `--- ${section.title} (matches: ${section.globs.join(', ')}) ---\n`;
      prompt += section.content + '\n';
      prompt += '--- END ---\n';
    }
  }

  // Index of remaining sections (non-glob or non-matched)
  const injectedFilenames = new Set(result.injectedSections.map(s => s.filename));
  const indexSections = result.index.sections.filter(s =>
    s.title !== '' && !injectedFilenames.has(s.filename)
  );

  if (indexSections.length > 0) {
    prompt += '\n[Rules Index — read with read_file as needed]\n';
    for (const s of indexSections) {
      prompt += `${s.index}. ${s.title} → ${sidebarDir}/.moraya/rules/${s.filename}\n`;
      if (s.summary) {
        prompt += `   ${s.summary}\n`;
      }
    }
    prompt += 'Read relevant sections with read_file before generating content.\n';
  }

  prompt += '=== END Rules ===';
  return prompt;
}
