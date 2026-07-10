<script lang="ts">
  import { onMount } from 'svelte';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { t } from '$lib/i18n';
  import {
    listVersions,
    restoreVersion,
    clearVersions,
    type VersionEntry,
  } from '$lib/services/version-history';

  let {
    filePath,
    fileName,
    onClose,
    onRestored,
  }: {
    filePath: string;
    fileName: string;
    onClose: () => void;
    onRestored: (content: string) => void;
  } = $props();

  let entries = $state<VersionEntry[]>([]);
  let loading = $state(true);
  let busy = $state(false);

  async function refresh() {
    loading = true;
    entries = await listVersions(filePath);
    loading = false;
  }

  onMount(() => {
    refresh();
  });

  function formatTime(entry: VersionEntry): string {
    if (entry.createdAt) {
      const d = new Date(entry.createdAt);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
    // meta was rebuilt without timestamps — fall back to the filename stem
    return entry.file.replace(/(_r\d+)?\.md$/, '').replace('_', ' ');
  }

  function formatSize(bytes: number): string {
    if (bytes <= 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  /**
   * Cloud-sync badge (Picora doc_revisions phase, not yet wired): shown once
   * an entry carries a `remote` mapping — always absent in the local-only phase.
   */
  function isCloudSynced(entry: VersionEntry): boolean {
    return entry.remote != null;
  }

  async function handleRestore(entry: VersionEntry) {
    if (busy) return;
    const confirmed = await ask(
      $t('version_history.restore_confirm', { time: formatTime(entry) }),
      { title: $t('version_history.restore'), kind: 'warning' }
    );
    if (!confirmed) return;
    busy = true;
    const restored = await restoreVersion(filePath, entry);
    busy = false;
    if (restored != null) {
      onRestored(restored);
      await refresh();
    }
  }

  async function handleClear() {
    if (busy || entries.length === 0) return;
    const confirmed = await ask($t('version_history.clear_confirm'), {
      title: $t('version_history.clear'),
      kind: 'warning',
    });
    if (!confirmed) return;
    busy = true;
    const ok = await clearVersions(filePath);
    busy = false;
    if (ok) entries = [];
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="vh-scrim" onclick={onClose}>
  <div class="vh-sheet" onclick={(e) => e.stopPropagation()}>
    <div class="vh-header">
      <span class="vh-title">{$t('version_history.title')}</span>
      <span class="vh-file" title={filePath}>{fileName}</span>
      <div class="vh-header-actions">
        {#if entries.length > 0}
          <button class="vh-clear" onclick={handleClear} disabled={busy}>
            {$t('version_history.clear')}
          </button>
        {/if}
        <button class="vh-close" onclick={onClose} aria-label={$t('common.close')}>✕</button>
      </div>
    </div>

    <div class="vh-list">
      {#if loading}
        <div class="vh-empty">…</div>
      {:else if entries.length === 0}
        <div class="vh-empty">{$t('version_history.empty')}</div>
      {:else}
        {#each entries as entry (entry.revNumber)}
          <div class="vh-row">
            <span class="vh-rev">#{entry.revNumber}</span>
            <span class="vh-time">{formatTime(entry)}</span>
            <span class="vh-origin" class:origin-manual={entry.origin === 'manual'} class:origin-restore={entry.origin === 'restore'}>
              {$t(`version_history.origin_${entry.origin}`)}
            </span>
            <span class="vh-size">{formatSize(entry.sizeBytes)}</span>
            {#if isCloudSynced(entry)}
              <!-- Picora brand mark (picora-mark-mono-blue.svg) — cloud-synced badge -->
              <span class="vh-cloud" title={$t('version_history.cloud_synced')}>
                <svg width="10" height="12" viewBox="8 6 16 20" fill="none" aria-hidden="true"><path d="M9.5 7.5v17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="14" r="6.5" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="14" r="2.4" fill="currentColor"/></svg>
              </span>
            {/if}
            <button class="vh-restore" onclick={() => handleRestore(entry)} disabled={busy}>
              {$t('version_history.restore')}
            </button>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .vh-scrim {
    position: fixed;
    inset: 0;
    z-index: 500;
  }

  .vh-sheet {
    position: absolute;
    bottom: calc(var(--statusbar-height) + 4px);
    left: 50%;
    transform: translateX(-50%);
    width: min(720px, calc(100vw - 2rem));
    max-height: 50vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.22);
    animation: vh-slide-up 0.16s ease-out;
  }

  @keyframes vh-slide-up {
    from { transform: translateX(-50%) translateY(12px); opacity: 0; }
    to { transform: translateX(-50%) translateY(0); opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .vh-sheet { animation: none; }
  }

  .vh-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--border-color);
  }

  .vh-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .vh-file {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vh-header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .vh-clear {
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-muted);
    border-radius: 4px;
    font-size: var(--font-size-xs);
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .vh-clear:hover:not(:disabled) { color: var(--color-error, #e53e3e); border-color: var(--color-error, #e53e3e); }

  .vh-close {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9rem;
    line-height: 1;
    padding: 0.15rem;
  }
  .vh-close:hover { color: var(--text-primary); }

  .vh-list {
    overflow-y: auto;
    padding: 0.25rem 0;
  }

  .vh-empty {
    padding: 1.5rem 0;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .vh-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.9rem;
    font-size: var(--font-size-xs);
  }
  .vh-row:hover { background: var(--bg-hover); }

  .vh-rev {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    min-width: 2.2em;
    flex-shrink: 0;
  }

  .vh-time {
    color: var(--text-primary);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .vh-origin {
    color: var(--text-muted);
    border: 1px solid var(--border-color);
    border-radius: 3px;
    padding: 0 0.35rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .vh-origin.origin-manual { color: var(--accent-color); border-color: var(--accent-color); }
  .vh-origin.origin-restore { color: var(--color-warning, #d69e2e); border-color: var(--color-warning, #d69e2e); }

  .vh-size {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    margin-left: auto;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .vh-cloud {
    color: #2563eb;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .vh-restore {
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-primary);
    border-radius: 4px;
    font-size: var(--font-size-xs);
    padding: 0.15rem 0.6rem;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .vh-restore:hover:not(:disabled) { border-color: var(--accent-color); color: var(--accent-color); }
  .vh-restore:disabled { opacity: 0.5; cursor: default; }
</style>
