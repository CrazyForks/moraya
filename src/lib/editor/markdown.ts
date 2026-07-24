/**
 * Moraya markdown bridge.
 *
 * Wraps `@moraya/core`'s parser/serializer with the bridged
 * consumer schema as default, so moraya call sites that don't pass an
 * explicit schema get docs whose `node.type` / `mark.type` references
 * match the bridged schema (TauriMediaResolver injection).
 *
 * Without this default-binding, docs returned to moraya's editor would
 * carry NodeType identities from core's internal `defaultSchema`, which
 * are different references from the bridged schema's NodeTypes — leading
 * to broken `toggleMark` / `setBlockType` behavior because ProseMirror
 * compares by type identity.
 */

import {
  parseMarkdown as coreParseMarkdown,
  parseMarkdownAsync as coreParseMarkdownAsync,
  serializeMarkdown as coreSerializeMarkdown,
} from '@moraya/core'
import { Fragment, type Node as PmNode } from 'prosemirror-model'
import { schema } from './schema'
import { trailingBlankParagraphCount } from './markdown-trailing'

/** Re-attach trailing empty paragraphs that markdown parsing discards. */
function restoreTrailingBlanks(doc: PmNode, markdown: string): PmNode {
  const n = trailingBlankParagraphCount(markdown)
  const paragraph = schema.nodes.paragraph
  if (n === 0 || !paragraph) return doc
  const extras: PmNode[] = []
  for (let i = 0; i < n; i++) {
    const empty = paragraph.createAndFill()
    if (empty) extras.push(empty)
  }
  if (extras.length === 0) return doc
  return doc.copy(doc.content.append(Fragment.fromArray(extras)))
}

/** Parse markdown to ProseMirror doc bound to moraya's bridged schema. Never throws (§4.5). */
export function parseMarkdown(markdown: string): PmNode {
  return restoreTrailingBlanks(coreParseMarkdown(markdown, schema), markdown)
}

/** Async variant with 50KB threshold for setTimeout(0) yield. Never rejects (§4.5). */
export async function parseMarkdownAsync(markdown: string): Promise<PmNode> {
  return restoreTrailingBlanks(await coreParseMarkdownAsync(markdown, schema), markdown)
}

/** Serialize a ProseMirror doc back to markdown. Never throws (§4.5). */
export function serializeMarkdown(doc: PmNode): string {
  return coreSerializeMarkdown(doc)
}
