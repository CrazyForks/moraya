import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '$lib/utils/platform';

interface NamingRule {
  pattern: string;   // e.g. '{date}-{title}' or '{title}'
  maxLength: number; // max total filename length (without .md extension)
}

// Heading keywords for detecting a naming-rule section in MORAYA.md
const NAMING_HEADING_RE = /^(#{1,3})\s+.*(?:命名|文件名|naming|filename|file[\s_-]*name)/im;

// Directive patterns inside the naming section
const PATTERN_RE = /(?:格式|pattern|format)\s*[:：]\s*[`"']?(\{[^`"'\n]+\}[^`"'\n]*)[`"']?/i;
const MAX_LEN_RE = /(?:最大长度|max[_\s-]*(?:length|len))\s*[:：]\s*(\d+)/i;

/**
 * Parse naming rules from MORAYA.md content.
 * Looks for a section whose heading contains naming-related keywords,
 * then extracts `pattern` and `maxLength` directives from that section.
 */
export function parseNamingRules(morayaContent: string): NamingRule | null {
  const headingMatch = morayaContent.match(NAMING_HEADING_RE);
  if (!headingMatch) return null;

  const headingLevel = headingMatch[1].length;
  const afterHeading = morayaContent.slice(headingMatch.index!);
  const lines = afterHeading.split('\n');

  // Collect section body (stop at next heading of same or higher level)
  let body = '';
  for (let i = 1; i < lines.length; i++) {
    const hm = lines[i].match(/^(#{1,6})\s/);
    if (hm && hm[1].length <= headingLevel) break;
    body += lines[i] + '\n';
  }

  let pattern = '{title}';
  const pm = body.match(PATTERN_RE);
  if (pm) pattern = pm[1].trim();

  let maxLength = 50;
  const lm = body.match(MAX_LEN_RE);
  if (lm) maxLength = Math.max(10, Math.min(120, parseInt(lm[1], 10)));

  return { pattern, maxLength };
}

/**
 * Apply a naming template with placeholders.
 *   {title}  — extracted heading / first line
 *   {date}   — YYYY-MM-DD
 *   {YYYY}, {MM}, {DD} — date components
 */
function applyTemplate(pattern: string, title: string): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  return pattern
    .replace(/\{title\}/gi, title)
    .replace(/\{date\}/gi, `${yyyy}-${mm}-${dd}`)
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd);
}

/**
 * Suggest a filename (without extension) for the given markdown content.
 *
 * Uses the Rust backend `kb_suggest_filename` for keyword extraction
 * (CJK-aware tokenization + TF scoring + stop-word filtering).
 *
 * If MORAYA.md has a naming-rule section, the extracted title is applied
 * to the naming template (e.g. `{date}-{title}`).
 *
 * @param content        Markdown document content
 * @param morayaContent  Optional MORAYA.md content for naming rules
 * @returns suggested filename without extension, or 'untitled'
 */
export async function suggestFileName(content: string, morayaContent?: string): Promise<string> {
  if (!content.trim()) return 'untitled';

  // Parse MORAYA.md naming rules first (to determine maxLength)
  const rules = morayaContent ? parseNamingRules(morayaContent) : null;
  const maxLen = rules?.maxLength ?? 50;

  // Call Rust backend for keyword-based filename suggestion
  let suggested = 'untitled';
  if (isTauri) {
    try {
      suggested = await invoke<string>('kb_suggest_filename', {
        content,
        maxLength: maxLen,
      });
    } catch {
      // Fallback if Rust command fails
      suggested = 'untitled';
    }
  }

  if (suggested === 'untitled') return 'untitled';

  // If MORAYA.md has a naming-rule template, apply it
  if (rules) {
    const nonTitleLen = applyTemplate(rules.pattern, '').length;
    const titleBudget = Math.max(10, rules.maxLength - nonTitleLen);
    const truncated = suggested.slice(0, titleBudget);
    const result = applyTemplate(rules.pattern, truncated);
    return result || 'untitled';
  }

  return suggested;
}
