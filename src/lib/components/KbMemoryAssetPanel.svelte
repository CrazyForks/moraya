<script lang="ts">
  /**
   * Per-KB "AI memory asset" panel — the shared inner control used both inline
   * in KbSyncSettings and inside KbMemoryAssetDialog (Sidebar). Binds external
   * AI tool memory dirs (~/.claude …) to THIS KB's cloud KB, backed up via the
   * memory binding-sync engine. Bindings are keyed globally by namespace; here
   * we only show/route those pointing at this KB's picoraKbId.
   *
   * Delete semantics (three tiers):
   *   - bound      → unbind (removes the local link; the cloud copy stays)
   *   - cloud-only → the namespace still exists in the cloud after unbinding;
   *                  only here can its cloud copy be deleted (with confirm)
   *   - local dir  → never deleted by any action
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import type { KnowledgeBase } from '$lib/stores/files-store';
  import {
    listBindings,
    addToolBinding,
    addCustomBinding,
    removeBinding,
    syncBinding,
    restoreBinding,
    toolDirPresent,
    scanHomeMemoryDirs,
    getToolProfile,
    listCloudNamespaces,
    deleteCloudNamespace,
    EXTERNAL_TOOLS,
    type MemoryBinding,
  } from '$lib/services/memory';

  let { kb }: { kb: KnowledgeBase } = $props();

  const picoraKbId = $derived(kb.picoraBinding?.picoraKbId ?? '');

  let bindings = $state<MemoryBinding[]>([]);
  let cloudNamespaces = $state<string[]>([]);
  let presentTools = $state<string[]>([]);
  let busy = $state(false);
  let statusKey = $state<string | null>(null);

  // Unified add flow.
  let showAdd = $state(false);
  let customPath = $state('');
  let scannedDirs = $state<Array<{ name: string; path: string }>>([]);
  let scanned = $state(false);

  // Which cloud-only namespace is pending a delete confirmation.
  let confirmDeleteNs = $state<string | null>(null);

  // Bindings routed to THIS KB's cloud KB.
  let kbBindings = $derived(bindings.filter((b) => b.kbId === picoraKbId));
  let boundMounts = $derived(new Set(kbBindings.map((b) => b.mountAs)));
  // Namespaces that exist in the cloud KB but have no local binding here.
  let cloudOnly = $derived(cloudNamespaces.filter((ns) => !boundMounts.has(ns)));
  // Tools whose local dir exists and which aren't bound anywhere yet
  // (namespaces are globally unique, so a bound tool can't be re-bound here).
  let bindableTools = $derived(
    EXTERNAL_TOOLS.filter((tool) => presentTools.includes(tool) && !bindings.some((b) => b.tool === tool)),
  );

  onMount(refresh);

  async function refresh() {
    bindings = await listBindings();
    const present: string[] = [];
    for (const tool of EXTERNAL_TOOLS) if (await toolDirPresent(tool)) present.push(tool);
    presentTools = present;
    cloudNamespaces = picoraKbId ? await listCloudNamespaces(picoraKbId) : [];
  }

  async function handleBind(tool: string) {
    if (busy || !picoraKbId) return;
    busy = true;
    statusKey = null;
    try {
      const b = await addToolBinding(tool, undefined, picoraKbId);
      if (b) await syncBinding(b);
      showAdd = false;
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function handleScan() {
    if (busy) return;
    busy = true;
    try {
      const dirs = await scanHomeMemoryDirs();
      // Hide dirs already bound or handled by a detected tool.
      const known = new Set<string>(bindings.map((b) => b.mountAs));
      for (const tool of EXTERNAL_TOOLS) {
        const m = getToolProfile(tool)?.mountAs;
        if (m) known.add(m);
      }
      scannedDirs = dirs.filter((d) => !known.has(d.name));
      scanned = true;
    } finally {
      busy = false;
    }
  }

  async function handleBindCustom() {
    const path = customPath.trim();
    if (busy || !picoraKbId || !path) return;
    // Uniqueness: the same local dir can only be added once to this KB.
    if (bindings.some((b) => b.kbId === picoraKbId && b.externalPath === path)) {
      statusKey = 'kb_sync.memory_asset.already_added';
      return;
    }
    busy = true;
    statusKey = null;
    try {
      const b = await addCustomBinding(path, picoraKbId);
      await syncBinding(b);
      customPath = '';
      scanned = false;
      scannedDirs = [];
      showAdd = false;
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function handleSync(b: MemoryBinding) {
    if (busy) return;
    busy = true;
    try { await syncBinding(b); statusKey = 'kb_sync.memory_asset.synced'; await refresh(); } finally { busy = false; }
  }

  async function handleRestore(b: MemoryBinding) {
    if (busy) return;
    busy = true;
    try { await restoreBinding(b); statusKey = 'kb_sync.memory_asset.restored'; } finally { busy = false; }
  }

  // Unbind: remove the local link only. The cloud copy is kept and surfaces as a
  // "cloud-only" row afterward. Never deletes the local dir.
  async function handleUnbind(mountAs: string) {
    if (busy) return;
    busy = true;
    try { await removeBinding(mountAs); await refresh(); } finally { busy = false; }
  }

  // Delete cloud: only allowed for cloud-only namespaces (guarded here + in UI).
  async function handleDeleteCloud(ns: string) {
    if (busy || !picoraKbId || boundMounts.has(ns)) return;
    busy = true;
    statusKey = null;
    try {
      await deleteCloudNamespace(picoraKbId, ns);
      confirmDeleteNs = null;
      statusKey = 'kb_sync.memory_asset.cloud_deleted';
      await refresh();
    } finally {
      busy = false;
    }
  }

  function toggleAdd() {
    showAdd = !showAdd;
    statusKey = null;
    if (!showAdd) { scanned = false; scannedDirs = []; customPath = ''; }
  }
</script>

<div class="kb-memory-asset">
  <section class="ma-section">
    <div class="ma-header">
      <h4 class="ma-title">{$t('kb_sync.memory_asset.bindings_title')}</h4>
      <p class="ma-desc">{$t('kb_sync.memory_asset.bindings_desc')}</p>
    </div>

    {#if !picoraKbId}
      <p class="empty-hint">{$t('kb_sync.memory_asset.needs_picora')}</p>
    {:else}
      <div class="ma-card">
        <!-- Bound namespaces (routed to this KB) -->
        {#each kbBindings as b (b.mountAs)}
          <div class="binding-row">
            <span class="binding-info">
              <strong>{b.tool}</strong>
              <code>{b.externalPath} → {b.mountAs}/</code>
            </span>
            <div class="binding-actions">
              <button class="ghost-btn" onclick={() => handleSync(b)} disabled={busy}>{$t('memory.sync_now')}</button>
              <button class="ghost-btn" onclick={() => handleRestore(b)} disabled={busy}>{$t('memory.restore')}</button>
              <button class="cancel-btn" onclick={() => handleUnbind(b.mountAs)} disabled={busy}>{$t('memory.unbind')}</button>
            </div>
          </div>
        {/each}

        <!-- Cloud-only namespaces (unbound but still in the cloud) -->
        {#each cloudOnly as ns (ns)}
          <div class="binding-row cloud-only-row">
            <span class="binding-info">
              <code>{ns}/</code>
              <span class="dim">{$t('kb_sync.memory_asset.cloud_only')}</span>
            </span>
            <div class="binding-actions">
              {#if confirmDeleteNs === ns}
                <span class="confirm-text">{$t('kb_sync.memory_asset.delete_cloud_confirm')}</span>
                <button class="danger-btn" onclick={() => handleDeleteCloud(ns)} disabled={busy}>{$t('kb_sync.memory_asset.confirm_delete')}</button>
                <button class="ghost-btn" onclick={() => (confirmDeleteNs = null)} disabled={busy}>{$t('kb_sync.memory_asset.cancel')}</button>
              {:else}
                <button class="danger-btn" onclick={() => (confirmDeleteNs = ns)} disabled={busy}>{$t('kb_sync.memory_asset.delete_cloud')}</button>
              {/if}
            </div>
          </div>
        {/each}

        {#if kbBindings.length === 0 && cloudOnly.length === 0}
          <p class="empty-hint">{$t('kb_sync.memory_asset.none_detected')}</p>
        {/if}

        <!-- Unified add -->
        {#if !showAdd}
          <button class="add-toggle" onclick={toggleAdd} disabled={busy}>+ {$t('kb_sync.memory_asset.add_dir')}</button>
        {:else}
          <div class="add-area">
            {#each bindableTools as tool (tool)}
              <button class="detected-chip" onclick={() => handleBind(tool)} disabled={busy}>
                <strong>{tool}</strong> <span class="dim">{$t('kb_sync.memory_asset.detected')}</span>
              </button>
            {/each}

            <div class="add-row">
              <input
                class="path-input"
                bind:value={customPath}
                placeholder="~/.xxx"
                spellcheck="false"
                autocapitalize="off"
                autocomplete="off"
              />
              <button class="ghost-btn" onclick={handleBindCustom} disabled={busy || !customPath.trim()}>{$t('memory.bind')}</button>
              <button class="ghost-btn" onclick={handleScan} disabled={busy}>{$t('kb_sync.memory_asset.scan_dirs')}</button>
            </div>
            <span class="dim">{$t('kb_sync.memory_asset.add_dir_hint')}</span>

            {#if scanned}
              {#if scannedDirs.length === 0}
                <p class="empty-hint">{$t('kb_sync.memory_asset.scan_empty')}</p>
              {:else}
                <div class="scan-list">
                  {#each scannedDirs as d (d.path)}
                    <button class="scan-item" onclick={() => { customPath = d.path; }} title={d.path}>{d.name}</button>
                  {/each}
                </div>
                <span class="dim">{$t('kb_sync.memory_asset.scan_pick_hint')}</span>
              {/if}
            {/if}

            <button class="add-toggle" onclick={toggleAdd} disabled={busy}>{$t('kb_sync.memory_asset.cancel')}</button>
          </div>
        {/if}
      </div>
    {/if}

    {#if statusKey}
      <p class="ma-status">{$t(statusKey)}</p>
    {/if}
  </section>
</div>

<style>
  .kb-memory-asset {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 0.75rem 0.9rem;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-light);
  }
  .ma-section { display: flex; flex-direction: column; gap: 0.5rem; }
  .ma-header { display: flex; flex-direction: column; gap: 0.15rem; }
  .ma-title { margin: 0; font-size: var(--font-size-sm); font-weight: 600; color: var(--text-primary); }
  .ma-desc { margin: 0; font-size: var(--font-size-xs); color: var(--text-secondary); }
  .ma-card {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .binding-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .cloud-only-row { opacity: 0.85; }
  .binding-info { font-size: var(--font-size-sm); color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .binding-info code { font-size: var(--font-size-xs); color: var(--text-secondary); }
  .binding-info .dim { font-size: var(--font-size-xs); color: var(--text-muted); }
  .binding-actions { display: flex; align-items: center; gap: 0.35rem; flex-shrink: 0; }
  .confirm-text { font-size: var(--font-size-xs); color: var(--text-secondary); }
  .empty-hint { margin: 0; font-size: var(--font-size-sm); color: var(--text-secondary); }
  .add-toggle {
    align-self: flex-start;
    padding: 0.3rem 0.7rem;
    border-radius: 6px;
    font-size: var(--font-size-xs);
    cursor: pointer;
    border: 1px dashed var(--border-color);
    background: transparent;
    color: var(--text-secondary);
  }
  .add-toggle:hover { background: var(--bg-hover); color: var(--text-primary); }
  .add-area { display: flex; flex-direction: column; gap: 0.4rem; }
  .detected-chip {
    align-self: flex-start;
    padding: 0.3rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    cursor: pointer;
  }
  .detected-chip:hover { background: var(--bg-hover); border-color: var(--accent-color); }
  .add-row { display: flex; align-items: center; gap: 0.5rem; }
  .path-input {
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    font-family: var(--font-mono, monospace);
  }
  .path-input:focus { outline: none; border-color: var(--accent-color); }
  .add-area .dim { font-size: var(--font-size-xs); color: var(--text-muted); }
  .scan-list { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .scan-item {
    padding: 0.2rem 0.55rem;
    border-radius: 6px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono, monospace);
    cursor: pointer;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-primary);
    white-space: nowrap;
  }
  .scan-item:hover { background: var(--bg-hover); border-color: var(--accent-color); }
  .ma-status { margin: 0; font-size: var(--font-size-xs); color: var(--text-secondary); }
  .ghost-btn, .cancel-btn, .danger-btn {
    padding: 0.3rem 0.7rem;
    border-radius: 6px;
    font-size: var(--font-size-xs);
    cursor: pointer;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-primary);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .danger-btn { color: var(--color-danger, #d9534f); }
  .danger-btn:hover { background: var(--color-danger, #d9534f); color: #fff; border-color: var(--color-danger, #d9534f); }
  .ghost-btn:disabled, .cancel-btn:disabled, .danger-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
