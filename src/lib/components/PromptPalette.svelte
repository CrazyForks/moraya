<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { filesStore } from '$lib/stores/files-store';
  import {
    loadPromptDocs,
    markPromptUsed,
    rankPrompts,
    assembleCard,
    bindContextFile,
    promoteToTemplate,
    archivePrompt,
    type PromptAssetDoc,
  } from '$lib/services/prompt-asset';

  let {
    onClose,
    onInsertToEditor,
    onToast,
    activeFilePath = null,
  }: {
    onClose: () => void;
    /** Insert the prompt body into the active editor (optional). */
    onInsertToEditor?: (text: string) => void;
    /** Surface a transient status message (copied / inserted). */
    onToast?: (text: string) => void;
    /** Absolute path of the currently open file, for "bind as context". */
    activeFilePath?: string | null;
  } = $props();

  let docs = $state<PromptAssetDoc[]>([]);
  let loading = $state(true);
  let hasKb = $state(true);
  let query = $state('');
  let activeIndex = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);

  let ranked = $derived(rankPrompts(docs, query, nowMs()));
  let selected = $derived(ranked[Math.min(activeIndex, ranked.length - 1)] ?? null);

  function nowMs(): number {
    return new Date().getTime();
  }

  onMount(async () => {
    const kb = filesStore.getActiveKnowledgeBase();
    if (!kb) {
      hasKb = false;
      loading = false;
      return;
    }
    docs = await loadPromptDocs(kb.path);
    loading = false;
    requestAnimationFrame(() => inputEl?.focus());
  });

  $effect(() => {
    // Keep the highlight in range as the filtered list changes.
    void query;
    if (activeIndex >= ranked.length) activeIndex = Math.max(0, ranked.length - 1);
  });

  async function recordUse(doc: PromptAssetDoc) {
    const kb = filesStore.getActiveKnowledgeBase();
    if (!kb) return;
    await markPromptUsed(kb.path, doc.relativePath, new Date().toISOString());
    doc.meta.usageCount += 1;
  }

  async function copyPrompt(doc: PromptAssetDoc) {
    try {
      await navigator.clipboard.writeText(doc.body);
      onToast?.($t('prompt_recall.copied'));
    } catch {
      onToast?.($t('prompt_recall.copy_failed'));
      return;
    }
    void recordUse(doc);
    onClose();
  }

  function insertPrompt(doc: PromptAssetDoc) {
    if (!onInsertToEditor) return;
    onInsertToEditor(doc.body);
    onToast?.($t('prompt_recall.inserted'));
    void recordUse(doc);
    onClose();
  }

  function hasContext(doc: PromptAssetDoc): boolean {
    return doc.meta.contextFiles.length > 0 || doc.meta.contextNotes.trim().length > 0;
  }

  async function assembleAndCopy(doc: PromptAssetDoc) {
    const kb = filesStore.getActiveKnowledgeBase();
    if (!kb) return;
    const text = await assembleCard(kb.path, doc, {
      background: $t('prompt_card.background'),
      contextFile: $t('prompt_card.context_file'),
    });
    try {
      await navigator.clipboard.writeText(text);
      onToast?.($t('prompt_recall.card_copied'));
    } catch {
      onToast?.($t('prompt_recall.copy_failed'));
      return;
    }
    void recordUse(doc);
    onClose();
  }

  async function bindActiveFile(doc: PromptAssetDoc) {
    const kb = filesStore.getActiveKnowledgeBase();
    if (!kb || !activeFilePath) return;
    const rel = await bindContextFile(kb.path, doc.relativePath, activeFilePath);
    if (rel) {
      doc.meta.contextFiles = [...doc.meta.contextFiles, rel];
      docs = [...docs]; // nudge reactivity for the context badge
      onToast?.($t('prompt_recall.bound'));
    } else {
      onToast?.($t('prompt_recall.bind_unavailable'));
    }
  }

  async function promote(doc: PromptAssetDoc) {
    try {
      await promoteToTemplate(doc);
      onToast?.($t('prompt_recall.promoted'));
    } catch {
      onToast?.($t('prompt_recall.promote_failed'));
    }
  }

  async function archive(doc: PromptAssetDoc) {
    const kb = filesStore.getActiveKnowledgeBase();
    if (!kb) return;
    const rel = await archivePrompt(kb.path, doc.relativePath);
    if (rel) {
      docs = docs.filter((d) => d.relativePath !== doc.relativePath);
      onToast?.($t('prompt_recall.archived'));
    } else {
      onToast?.($t('prompt_recall.archive_failed'));
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, ranked.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!selected) return;
      if ((event.metaKey || event.ctrlKey) && onInsertToEditor) insertPrompt(selected);
      else copyPrompt(selected);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pp-overlay" onclick={onClose}>
  <div class="pp-panel" onclick={(e) => e.stopPropagation()}>
    <input
      class="pp-search"
      bind:this={inputEl}
      bind:value={query}
      onkeydown={onKeydown}
      placeholder={$t('prompt_recall.search_placeholder')}
      spellcheck="false"
    />

    {#if loading}
      <p class="pp-hint">{$t('prompt_recall.loading')}</p>
    {:else if !hasKb}
      <p class="pp-hint">{$t('prompt_recall.no_kb')}</p>
    {:else if docs.length === 0}
      <p class="pp-hint">{$t('prompt_recall.empty')}</p>
    {:else if ranked.length === 0}
      <p class="pp-hint">{$t('prompt_recall.no_match')}</p>
    {:else}
      <div class="pp-body">
        <ul class="pp-list">
          {#each ranked as doc, i (doc.relativePath)}
            <li>
              <button
                class="pp-item"
                class:active={i === activeIndex}
                onmouseenter={() => (activeIndex = i)}
                onclick={() => copyPrompt(doc)}
              >
                <span class="pp-item-title">
                  {doc.title}
                  {#if hasContext(doc)}<span class="pp-ctx-badge" title={$t('prompt_recall.has_context')}>📎</span>{/if}
                </span>
                <span class="pp-item-meta">
                  {doc.meta.project}
                  {#if doc.meta.usageCount > 0}· {$t('prompt_recall.uses', { n: String(doc.meta.usageCount) })}{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
        {#if selected}
          <div class="pp-preview">
            <pre>{selected.body}</pre>
            {#if selected.meta.contextFiles.length > 0}
              <div class="pp-ctx-list">
                <span class="pp-ctx-label">📎 {$t('prompt_recall.context_files')}</span>
                {#each selected.meta.contextFiles as f}<code class="pp-ctx-file">{f}</code>{/each}
              </div>
            {/if}
            <div class="pp-actions">
              <button class="pp-btn primary" onclick={() => copyPrompt(selected!)}>{$t('prompt_recall.copy')}</button>
              {#if hasContext(selected)}
                <button class="pp-btn" onclick={() => assembleAndCopy(selected!)}>{$t('prompt_recall.assemble')}</button>
              {/if}
              {#if activeFilePath}
                <button class="pp-btn" onclick={() => bindActiveFile(selected!)}>{$t('prompt_recall.bind_file')}</button>
              {/if}
              {#if onInsertToEditor}
                <button class="pp-btn" onclick={() => insertPrompt(selected!)}>{$t('prompt_recall.insert')}</button>
              {/if}
              <button class="pp-btn subtle" onclick={() => promote(selected!)}>{$t('prompt_recall.promote')}</button>
              <button class="pp-btn subtle" onclick={() => archive(selected!)}>{$t('prompt_recall.archive')}</button>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .pp-overlay {
    position: fixed;
    inset: 0;
    z-index: 320;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
  }
  .pp-panel {
    width: min(720px, 90vw);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }
  .pp-search {
    padding: 12px 16px;
    border: none;
    border-bottom: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    outline: none;
  }
  .pp-hint {
    padding: 24px 16px;
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    text-align: center;
  }
  .pp-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
    min-height: 0;
    flex: 1;
  }
  .pp-list {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
    border-right: 1px solid var(--border-color);
  }
  .pp-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    color: var(--text-primary);
  }
  .pp-item.active { background: var(--bg-secondary); }
  .pp-item-title {
    font-size: var(--font-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pp-item-meta { font-size: var(--font-size-xs); color: var(--text-secondary); }
  .pp-preview {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 10px 12px;
  }
  .pp-preview pre {
    flex: 1;
    margin: 0 0 10px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .pp-ctx-badge { font-size: var(--font-size-xs); }
  .pp-ctx-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .pp-ctx-label { font-size: var(--font-size-xs); color: var(--text-secondary); }
  .pp-ctx-file {
    font-size: var(--font-size-xs);
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-family: var(--font-mono, monospace);
  }
  .pp-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .pp-btn {
    padding: 6px 14px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .pp-btn.primary { background: var(--accent-color, #4a7cff); color: #fff; border-color: transparent; }
  .pp-btn.subtle { background: transparent; color: var(--text-secondary); }
</style>
