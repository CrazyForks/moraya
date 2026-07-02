<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import { filesStore, type KnowledgeBase } from '$lib/stores/files-store';
  import type { ImageHostTarget } from '$lib/services/image-hosting';

  let { onOpenKbSync }: { onOpenKbSync: () => void } = $props();

  const tr = $t;

  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let picoraTargets = $state<ImageHostTarget[]>([]);

  const unsubFiles = filesStore.subscribe(s => { knowledgeBases = s.knowledgeBases; });
  const unsubSettings = settingsStore.subscribe(s => {
    picoraTargets = (s.imageHostTargets || []).filter(t => t.provider === 'picora');
  });
  onDestroy(() => { unsubFiles(); unsubSettings(); });

  let bound = $derived(knowledgeBases.filter(kb => !!kb.picoraBinding));
  let unbound = $derived(knowledgeBases.filter(kb => !kb.picoraBinding));

  function targetLabel(targetId: string): string {
    const t = picoraTargets.find(t => t.id === targetId);
    return t ? (t.picoraUserEmail || t.name || targetId.slice(0, 8)) : tr('settings.picora.kb_sync.missing_target');
  }

  function fmtSync(at: string | null): string {
    if (!at) return tr('settings.picora.kb_sync.never');
    try {
      const d = new Date(at);
      return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch { return at; }
  }
</script>

<section class="kb-sync-section">
  <header class="section-header">
    <h3>{tr('settings.picora.kb_sync.title')}</h3>
    <button class="btn-link" onclick={onOpenKbSync}>{tr('settings.picora.kb_sync.open_manager')} →</button>
  </header>

  {#if bound.length === 0 && unbound.length === 0}
    <p class="empty">{tr('settings.picora.kb_sync.empty')}</p>
  {:else}
    <div class="kb-list">
      {#each bound as kb (kb.id)}
        <div class="kb-row">
          <div class="kb-meta">
            <span class="kb-name">{kb.name}</span>
            <span class="kb-arrow">→</span>
            <span class="kb-target">{targetLabel(kb.picoraBinding!.picoraTargetId)} / {kb.picoraBinding!.picoraKbName}</span>
          </div>
          <div class="kb-status">
            {#if kb.picoraBinding!.lastSyncError}
              <span class="status-error" title={kb.picoraBinding!.lastSyncError}>⚠ {tr('settings.picora.kb_sync.error')}</span>
            {:else}
              <span class="status-ok">✓ {fmtSync(kb.picoraBinding!.lastSyncAt)}</span>
            {/if}
          </div>
        </div>
      {/each}
      {#if unbound.length > 0}
        <div class="unbound-block">
          <div class="unbound-label">{tr('settings.picora.kb_sync.unbound_label')}</div>
          {#each unbound as kb (kb.id)}
            <div class="kb-row unbound">
              <span class="kb-name">{kb.name}</span>
              <button class="btn-link" onclick={onOpenKbSync}>+ {tr('settings.picora.kb_sync.bind_action')}</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .kb-sync-section { display: flex; flex-direction: column; gap: 0.5rem; }
  .section-header { display: flex; align-items: center; justify-content: space-between; }
  .section-header h3 { margin: 0; font-size: var(--font-size-base); font-weight: 600; color: var(--text-primary); }
  .btn-link {
    background: transparent; border: none; cursor: pointer;
    color: var(--accent-color); font-size: var(--font-size-sm); padding: 0;
  }
  .btn-link:hover { text-decoration: underline; }
  .empty { font-size: var(--font-size-sm); color: var(--text-muted); margin: 0; }
  .kb-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .kb-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-light);
    border-radius: 4px;
    background: var(--bg-primary);
  }
  .kb-row.unbound { background: var(--bg-secondary); }
  .kb-meta { display: flex; align-items: center; gap: 0.4rem; font-size: var(--font-size-sm); min-width: 0; }
  .kb-name { color: var(--text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kb-arrow { color: var(--text-muted); }
  .kb-target { color: var(--text-secondary); font-family: var(--font-mono, monospace); font-size: var(--font-size-xs); }
  .kb-status { font-size: var(--font-size-xs); }
  .status-ok { color: #28a745; }
  .status-error { color: #dc3545; }
  .unbound-block { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.4rem; }
  .unbound-label { font-size: var(--font-size-xs); color: var(--text-muted); padding-left: 0.1rem; }
</style>
