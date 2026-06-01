<script lang="ts">
  import { t } from '$lib/i18n';
  import { invoke } from '@tauri-apps/api/core';
  import type { KnowledgeBase } from '$lib/stores/files-store';
  import { filesStore } from '$lib/stores/files-store';
  import { kbSyncStore } from '$lib/services/kb-sync/sync-service';
  import { picoraApiBase, fetchRaw } from '$lib/services/kb-sync/picora-kb-client';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { KbBinding, ConflictEntry, ConflictResolution } from '$lib/services/kb-sync/types';

  let { kb, binding, conflicts, onClose }: {
    kb: KnowledgeBase;
    binding: KbBinding;
    conflicts: ConflictEntry[];
    onClose: () => void;
  } = $props();

  let currentIndex = $state(0);
  let resolutions = $state<Map<string, ConflictResolution>>(new Map());
  let applying = $state(false);
  let error = $state('');

  let current = $derived(conflicts[currentIndex]);

  function setResolution(res: ConflictResolution) {
    if (!current) return;
    const next = new Map(resolutions);
    next.set(current.relativePath, res);
    resolutions = next;
  }

  function getResolution(): ConflictResolution | undefined {
    return current ? resolutions.get(current.relativePath) : undefined;
  }

  async function applyOne() {
    if (!current) return;
    const resolution = getResolution();
    if (!resolution) return;
    applying = true;
    error = '';
    try {
      await applySingle(current, resolution);
      // Remove from conflicts
      const newMap = new Map(resolutions);
      newMap.delete(current.relativePath);
      resolutions = newMap;
      kbSyncStore.setState(kb.id, {
        pendingConflicts: conflicts.filter(c => c.relativePath !== current.relativePath),
        conflictCount: Math.max(0, kbSyncStore.getState(kb.id).conflictCount - 1),
      });
      if (currentIndex >= conflicts.length - 1) {
        currentIndex = Math.max(0, conflicts.length - 2);
      }
    } catch (e) {
      error = typeof e === 'string' ? e : 'Failed to apply resolution';
    } finally {
      applying = false;
    }
  }

  async function applyAll() {
    applying = true;
    error = '';
    try {
      for (const conflict of conflicts) {
        const resolution = resolutions.get(conflict.relativePath);
        if (!resolution) continue;
        await applySingle(conflict, resolution);
      }
      kbSyncStore.setState(kb.id, { pendingConflicts: [], conflictCount: 0, status: 'idle' });
      onClose();
    } catch (e) {
      error = typeof e === 'string' ? e : 'Failed to apply resolutions';
    } finally {
      applying = false;
    }
  }

  async function applySingle(conflict: ConflictEntry, resolution: ConflictResolution) {
    const target = settingsStore.getState().imageHostTargets.find(t => t.id === binding.picoraTargetId);
    if (!target) throw new Error('Picora target not found');
    const apiBase = picoraApiBase(target.picoraApiUrl);
    const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
    const apiKey = await getPicoraApiKey(target);

    if (resolution === 'prefer-local') {
      // Upload local → overwrite remote
      const content = await invoke<string>('read_file', { path: `${kb.path}/${conflict.relativePath}` });
      await invoke('picora_kb_sync_batch', {
        apiBase,
        apiKey,
        kbId: binding.picoraKbId,
        ops: [{ op: 'upsert', relativePath: conflict.relativePath, content, sourceHash: conflict.localHash }],
      });
    } else if (resolution === 'prefer-remote') {
      // Download remote → overwrite local
      const content = await fetchRaw(apiBase, apiKey, binding.picoraKbId, conflict.relativePath);
      await invoke('write_file', { path: `${kb.path}/${conflict.relativePath}`, content });
    } else if (resolution === 'keep-both') {
      // Download remote to a .conflict.md copy, keep local as-is
      const content = await fetchRaw(apiBase, apiKey, binding.picoraKbId, conflict.relativePath);
      const conflictPath = conflict.relativePath.replace(/(\.[^.]+)$/, `.conflict-${Date.now()}$1`);
      await invoke('write_file', { path: `${kb.path}/${conflictPath}`, content });
    }
  }

  function formatDate(iso: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="conflict-overlay" onkeydown={(e) => e.key === 'Escape' && onClose()} onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="conflict-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="dialog-header">
      <span class="dialog-icon">⚠</span>
      <h3>{$t('kbSync.conflict.title').replace('{name}', kb.name).replace('{n}', String(conflicts.length))}</h3>
      <button class="close-btn" onclick={onClose}>&times;</button>
    </div>

    {#if conflicts.length === 0}
      <div class="dialog-body">
        <p class="empty-hint">{$t('kbSync.conflict.noConflicts')}</p>
      </div>
    {:else if current}
      <div class="nav-bar">
        <button class="nav-btn" disabled={currentIndex === 0} onclick={() => { currentIndex--; }}>‹</button>
        <span class="nav-label">{current.relativePath} ({currentIndex + 1}/{conflicts.length})</span>
        <button class="nav-btn" disabled={currentIndex >= conflicts.length - 1} onclick={() => { currentIndex++; }}>›</button>
      </div>

      <div class="diff-row">
        <div class="diff-side">
          <div class="diff-header">
            {$t('kbSync.conflict.local')}
            <span class="diff-meta">{formatDate(current.localUpdatedAt)} · {formatBytes(current.localSizeBytes)}</span>
          </div>
          <div class="diff-preview">{current.localPreview || $t('kbSync.conflict.noPreview')}</div>
        </div>
        <div class="diff-side">
          <div class="diff-header">
            {$t('kbSync.conflict.remote')}
            <span class="diff-meta">{formatDate(current.remoteUpdatedAt)} · {formatBytes(current.remoteSizeBytes)}</span>
          </div>
          <div class="diff-preview">{current.remotePreview || $t('kbSync.conflict.noPreview')}</div>
        </div>
      </div>

      <div class="resolution-area">
        {#each [
          { value: 'prefer-local', label: $t('kbSync.conflict.keepLocal') },
          { value: 'prefer-remote', label: $t('kbSync.conflict.keepRemote') },
          { value: 'keep-both', label: $t('kbSync.conflict.keepBoth') },
        ] as opt}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <label class="resolution-option" class:selected={getResolution() === opt.value}>
            <input
              type="radio"
              name="resolution"
              value={opt.value}
              checked={getResolution() === opt.value}
              onchange={() => setResolution(opt.value as ConflictResolution)}
            />
            {opt.label}
          </label>
        {/each}
      </div>

      {#if error}
        <p class="error-text">{error}</p>
      {/if}
    {/if}

    <div class="dialog-footer">
      <button class="btn btn-ghost" onclick={onClose}>{$t('common.close')}</button>
      {#if conflicts.length > 0}
        <button
          class="btn btn-ghost"
          disabled={!getResolution() || applying}
          onclick={() => { if (currentIndex < conflicts.length - 1) currentIndex++; }}
        >
          {$t('kbSync.conflict.skip')}
        </button>
        <button
          class="btn btn-primary"
          disabled={!getResolution() || applying}
          onclick={applyOne}
        >
          {$t('kbSync.conflict.applyOne')}
        </button>
        <button
          class="btn btn-primary"
          disabled={resolutions.size === 0 || applying}
          onclick={applyAll}
        >
          {$t('kbSync.conflict.applyAll').replace('{n}', String(resolutions.size))}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .conflict-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 250;
  }

  .conflict-dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    width: 720px;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 12px 40px rgba(0,0,0,0.25);
  }

  .dialog-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }

  .dialog-icon { font-size: 1rem; color: var(--warning-color, #e8a838); }

  .dialog-header h3 {
    margin: 0;
    flex: 1;
    font-size: var(--font-size-base);
    font-weight: 600;
  }

  .close-btn {
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0 0.25rem;
    line-height: 1;
  }

  .nav-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border-light);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .nav-btn {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 1rem;
    color: var(--text-secondary);
    padding: 0 0.25rem;
  }

  .nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .nav-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .diff-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    flex: 1;
    overflow: hidden;
    min-height: 200px;
  }

  .diff-side {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border-light);
    overflow: hidden;
  }

  .diff-side:last-child { border-right: none; }

  .diff-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0.4rem 0.75rem;
    background: var(--bg-secondary);
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border-light);
  }

  .diff-meta { font-weight: 400; color: var(--text-muted); }

  .diff-preview {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0.75rem;
    font-family: monospace;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .resolution-area {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .resolution-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    transition: background 0.1s;
  }

  .resolution-option.selected { background: color-mix(in srgb, var(--accent-color) 10%, transparent); }
  .resolution-option:hover { background: var(--bg-hover); }

  .error-text {
    padding: 0 1rem;
    font-size: var(--font-size-sm);
    color: var(--color-error, #e53e3e);
  }

  .empty-hint {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .btn {
    padding: 0.35rem 0.9rem;
    border-radius: 5px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost { background: transparent; border-color: var(--border-color); color: var(--text-secondary); }
  .btn-primary { background: var(--accent-color); color: white; }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
</style>
