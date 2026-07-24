import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { t } from '$lib/i18n';
import { settingsStore } from '$lib/stores/settings-store';
import { exportProgressStore } from '$lib/stores/export-progress-store';
import { renderMermaid } from '$lib/editor/plugins/mermaid-renderer';
import {
  exportDocument as coreExportDocument,
  markdownToHtml as coreMarkdownToHtml,
  markdownToHtmlBody as coreMarkdownToHtmlBody,
  inferDocumentTitle,
  type ExportFormat,
  type ExportProgress,
  type FileSink,
} from '@moraya/core/export';
import {
  exportPdfNative,
  defaultExportOptions,
  type PdfExportOptions,
} from './pdf-export-native';

// The document-export engine now lives in @moraya/core/export (extracted in core
// v0.11.0 so PC / Web / Mobile share one implementation). This module is the PC
// adapter: it supplies the Tauri file sink (save-dialog + write_file / bytes),
// the mermaid renderer, and the progress-store bridge, plus keeps the native
// print-to-PDF path (Tauri/Rust only) and the frozen public surface consumed by
// rss-publisher.ts, routes/print/+page.svelte, and routes/+page.svelte.

export type { ExportFormat };
// Re-exported for downstream consumers (rss-publisher, print route). Mermaid is
// unresolved here (async injected in export paths) — these text renderers keep
// mermaid as <pre><code> unless a renderer is passed, matching prior behavior.
export const markdownToHtml = (markdown: string, includeStyles = true) =>
  coreMarkdownToHtml(markdown, includeStyles, renderMermaid);
export const markdownToHtmlBody = coreMarkdownToHtmlBody;

interface ExportOption {
  format: ExportFormat;
  labelKey: string;
  extension: string;
  mimeType: string;
}

export const exportOptions: ExportOption[] = [
  { format: 'pdf', labelKey: 'export.pdf', extension: 'pdf', mimeType: 'application/pdf' },
  { format: 'html', labelKey: 'export.html', extension: 'html', mimeType: 'text/html' },
  { format: 'html-plain', labelKey: 'export.html_plain', extension: 'html', mimeType: 'text/html' },
  { format: 'image', labelKey: 'export.image', extension: 'png', mimeType: 'image/png' },
  { format: 'doc', labelKey: 'export.doc', extension: 'doc', mimeType: 'application/msword' },
  { format: 'latex', labelKey: 'export.latex', extension: 'tex', mimeType: 'application/x-latex' },
];

const TEXT_MIMES = new Set(['text/html', 'application/x-latex', 'text/plain', 'application/msword']);

/** Build a Tauri file sink bound to a pre-chosen save path. */
function tauriSink(path: string): FileSink {
  return {
    async save(_name, bytes, mime) {
      if (TEXT_MIMES.has(mime) || mime.startsWith('text/')) {
        // Text formats: write as a UTF-8 string via the existing command.
        await invoke('write_file', { path, content: new TextDecoder().decode(bytes) });
      } else {
        // Binary (PDF/PNG): raw-body IPC (no base64 inflation).
        await invoke('write_file_bytes', bytes, { headers: { 'X-File-Path': path } });
      }
    },
  };
}

/** Bridge core export progress phases onto the PC status-bar store. */
function bridgeProgress(p: ExportProgress): void {
  switch (p.phase) {
    case 'rendering':
      exportProgressStore.setPhase('rendering');
      break;
    case 'paginating':
      if (p.current != null && p.total != null) exportProgressStore.setPaginating(p.current, p.total);
      break;
    case 'writing':
      exportProgressStore.setPhase('writing');
      break;
    // 'preparing' / 'done' / 'error' handled by the caller around the core call.
  }
}

/**
 * Build a PdfExportOptions value from the user's settings + document title.
 */
function buildNativeOptions(documentTitle: string): PdfExportOptions {
  const opts = defaultExportOptions(documentTitle);
  const settings = get(settingsStore);
  const e = settings.exportSettings;
  if (!e) return opts;
  return {
    paper_size: e.pageSize,
    orientation: e.orientation,
    margins: { ...e.margins },
    header_enabled: e.headerEnabled,
    header_template: e.headerTemplate,
    footer_enabled: e.footerEnabled,
    footer_template: e.footerTemplate,
    font_size: e.fontSize,
    font_family: e.fontFamily,
    enable_highlight: e.enableHighlight,
    enable_mermaid: e.enableMermaid,
    enable_math: e.enableMath,
    document_title: documentTitle,
  };
}

/**
 * Export markdown content to the specified format.
 *
 * Accepts either a markdown string OR a lazy getter. For huge documents,
 * markdown serialization (ProseMirror → text) can take seconds-to-minutes;
 * passing a getter lets us show the save dialog FIRST and only pay that cost
 * after the user has actually committed to exporting.
 */
export async function exportDocument(
  markdownOrGetter: string | (() => string),
  format: ExportFormat,
): Promise<boolean> {
  const option = exportOptions.find((o) => o.format === format);
  if (!option) return false;

  const tr = get(t);
  const label = tr(option.labelKey);
  // Show the save dialog FIRST — it depends only on the format, so it can
  // appear instantly even while the editor is still busy. Resolving markdown
  // beforehand would block the JS main thread and delay the dialog.
  const path = await saveDialog({
    title: tr('export.export_as', { format: label }),
    defaultPath: `document.${option.extension}`,
    filters: [{ name: label, extensions: [option.extension] }],
  });
  if (!path || typeof path !== 'string') return false;

  // For PDF, show "preparing" BEFORE the blocking markdown serialization; yield
  // one frame so the status pill renders before we block the main thread.
  if (format === 'pdf') {
    exportProgressStore.start();
    await new Promise((r) => setTimeout(r, 0));
  }

  const markdown =
    typeof markdownOrGetter === 'function' ? markdownOrGetter() : markdownOrGetter;

  // Native print-to-PDF (Tauri/Rust) — opt-in, PC-only, not part of core.
  if (format === 'pdf') {
    const settings = get(settingsStore);
    const preferNative =
      (settings.exportSettings as { preferNativePdf?: boolean } | undefined)?.preferNativePdf ?? false;
    if (preferNative) {
      try {
        const opts = buildNativeOptions(inferDocumentTitle(markdown));
        await exportPdfNative(markdown, path, opts, (update) => {
          if (update.phase) exportProgressStore.setPhase(update.phase);
          if (update.phase === 'paginating' && update.current != null && update.total != null) {
            exportProgressStore.setPaginating(update.current, update.total);
          }
        });
        exportProgressStore.done();
        return true;
      } catch {
        // Native failed — fall through to the shared canvas pipeline.
        exportProgressStore.fallback();
      }
    }
  }

  // Shared @moraya/core/export path for every format (canvas PDF, long-image,
  // HTML/DOC/LaTeX). html2canvas/jsPDF resolve from PC's own dependencies.
  //
  // Only the canvas formats (PDF / image) surface the StatusBar progress pill —
  // they do the slow html2canvas work. Text formats (html / html-plain / doc /
  // latex) are near-instant, so we DON'T wire onProgress for them: otherwise
  // core's `writing` phase would light the pill with no matching done()/error()
  // to clear it, leaving "正在写入…" stuck forever.
  const usesProgress = format === 'pdf' || format === 'image';
  const result = await coreExportDocument(format, {
    sink: tauriSink(path),
    getMarkdown: () => markdown,
    documentTitle: inferDocumentTitle(markdown),
    mermaid: renderMermaid,
    ...(usesProgress ? { onProgress: bridgeProgress } : {}),
  });

  if (usesProgress) {
    if (result.ok) exportProgressStore.done();
    else exportProgressStore.error(result.message ?? 'Export failed');
  }
  if (!result.ok) throw new Error(result.message ?? 'Export failed');
  return true;
}
