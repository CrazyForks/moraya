#!/usr/bin/env node
/**
 * Anti-redrift gate for the AI provider catalog (desktop).
 *
 * The LLM provider catalog is a single source of truth in `@moraya/core/ai`.
 * `src/lib/services/ai/types.ts` MUST re-export `AIProvider` / `DEFAULT_MODELS`
 * / `PROVIDER_BASE_URLS` from core, never re-declare them locally — otherwise
 * the catalog silently forks again (the exact drift this migration removed).
 *
 * Fails (exit 1) if a local literal declaration of any of those three reappears.
 * Companion to scripts/check-core-dep.mjs; wired into .githooks/pre-push.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = 'src/lib/services/ai/types.ts'
const src = readFileSync(resolve(root, file), 'utf8')

const violations = []
// A local `type AIProvider = 'claude' | ...` union (re-export uses `{ AIProvider }`, no `=`).
if (/^\s*(?:export\s+)?type\s+AIProvider\s*=\s*['"]/m.test(src))
  violations.push("local `type AIProvider = '…'` union")
// A local `const DEFAULT_MODELS …= {` / `: Record` (re-export uses `export { DEFAULT_MODELS } from`).
if (/^\s*(?:export\s+)?const\s+DEFAULT_MODELS\b/m.test(src))
  violations.push('local `DEFAULT_MODELS` declaration')
if (/^\s*(?:export\s+)?const\s+PROVIDER_BASE_URLS\b/m.test(src))
  violations.push('local `PROVIDER_BASE_URLS` declaration')
// Image catalog (size maps + model lists) is sourced from @moraya/core/ai/image.
if (!/from '@moraya\/core\/ai\/image'/.test(src))
  violations.push('image catalog not sourced from @moraya/core/ai/image')
if (/^\s*(?:export\s+)?const\s+IMAGE_SIZE_MAP\s*[:=]/m.test(src))
  violations.push('local `IMAGE_SIZE_MAP` literal (re-export from @moraya/core/ai/image)')

if (violations.length) {
  console.error(`check-ai-catalog: ${file} must source the AI provider catalog from @moraya/core/ai, not re-declare it:`)
  for (const v of violations) console.error(`  - ${v}`)
  console.error('  Re-export from @moraya/core/ai (see project_ai_catalog_unification).')
  process.exit(1)
}
console.log('check-ai-catalog: ok (AI provider catalog sourced from @moraya/core/ai)')
