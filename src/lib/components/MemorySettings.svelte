<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { Select, type SelectOption } from '$lib/components/ui';
  import { settingsStore } from '$lib/stores/settings-store';
  import {
    listMemories,
    getHalfLife,
    setHalfLife,
    updateMemoryContent,
    deleteMemory,
    toggleMemory,
    resetAllMemories,
    memoryStore,
    runHealthCheck,
    syncNow,
    clearRemoteMemories,
    memorySyncStatus,
    listBindings,
    addToolBinding,
    removeBinding,
    syncBinding,
    restoreBinding,
    toolDirPresent,
    routeBindingToKb,
    listAvailableKbs,
    EXTERNAL_TOOLS,
    type MemorySyncStatusKind,
    type MemoryDoc,
    type MemoryHalfLife,
    type HealthReport,
    type HealthIssue,
    type MemoryCloudConfig,
    type MemoryBinding,
  } from '$lib/services/memory';
  import { HALF_LIFE_OPTIONS } from '$lib/services/memory/decay';

  // ── Local memory list ──────────────────────────────────────────────────
  let memories = $state<MemoryDoc[]>([]);
  let searchQuery = $state('');
  let selectedKind = $state<'all' | 'preference' | 'project' | 'fact'>('all');
  let halfLife = $state<MemoryHalfLife>(90);
  let editingId = $state<string | null>(null);
  let editContent = $state('');
  let healthReport = $state<HealthReport | null>(null);
  let confirmResetOpen = $state(false);
  let resetConfirmText = $state('');

  // ── Cloud sync ─────────────────────────────────────────────────────────
  let syncState = $state<MemorySyncStatusKind>('disabled');
  const unsubSync = memorySyncStatus.subscribe((s) => { syncState = s; });
  onDestroy(() => unsubSync());

  let cloud = $state<MemoryCloudConfig>({ enabled: false, targetId: null });
  let cloudBusy = $state(false);
  let confirmClearCloudOpen = $state(false);
  let clearCloudText = $state('');

  // Tool-memory bindings (P2/P3)
  let bindings = $state<MemoryBinding[]>([]);
  let availableKbs = $state<Array<{ id: string; name: string; slug?: string }>>([]);
  let presentTools = $state<string[]>([]); // external tools whose local dir exists
  let addKbSel = $state<Record<string, string>>({}); // tool → target kbId ('' = shared)

  // KB options for the target picker: shared "AI Memory" first, then the user's
  // other KBs (the shared memory KB itself is represented by the '' option).
  let kbOptions = $derived<SelectOption[]>([
    { value: '', label: $t('memory.shared_memory_kb') },
    ...availableKbs.filter((k) => k.slug !== 'memory').map((k) => ({ value: k.id, label: k.name })),
  ]);
  // Tools present locally but not yet bound.
  let bindableTools = $derived(
    EXTERNAL_TOOLS.filter((t) => presentTools.includes(t) && !bindings.some((b) => b.tool === t)),
  );
  function kbLabel(kbId?: string): string {
    if (!kbId) return $t('memory.shared_memory_kb');
    return availableKbs.find((k) => k.id === kbId)?.name ?? kbId;
  }

  // Picora-connected image-host targets (memory syncs to one of these accounts).
  let picoraTargets = $derived(
    ($settingsStore.imageHostTargets ?? []).filter((tg) => !!tg.picoraApiUrl),
  );
  let targetOptions = $derived<SelectOption[]>(
    picoraTargets.map((tg) => ({ value: tg.id, label: tg.name || tg.id })),
  );

  const halfLifeOptions: SelectOption[] = HALF_LIFE_OPTIONS.map((opt) => ({
    value: opt,
    label: opt === 'never' ? $t('memory.half_life_never') : `${opt} ${$t('memory.days')}`,
  }));
  const kindOptions: SelectOption[] = [
    { value: 'all', label: $t('memory.filter_all') },
    { value: 'preference', label: $t('memory.kind_preference') },
    { value: 'project', label: $t('memory.kind_project') },
    { value: 'fact', label: $t('memory.kind_fact') },
  ];

  onMount(() => {
    void refresh();
  });

  async function refresh() {
    memories = await memoryStore.getAll(true);
    halfLife = await getHalfLife();
    cloud = await memoryStore.getCloudConfig();
    // Single Picora account → auto-select it (no picker needed). The target KB
    // is always the account's shared "AI Memory" KB, discovered by the sync layer.
    if (!cloud.targetId && picoraTargets.length === 1) {
      cloud = { ...cloud, targetId: picoraTargets[0].id };
      await persistCloud();
    }
    bindings = await listBindings();
    availableKbs = await listAvailableKbs();
    const present: string[] = [];
    for (const t of EXTERNAL_TOOLS) if (await toolDirPresent(t)) present.push(t);
    presentTools = present;
    recomputeHealth();
  }

  // ── Tool-memory binding handlers ────────────────────────────────────────

  async function handleBindTool(tool: string) {
    if (cloudBusy) return;
    cloudBusy = true;
    try {
      const b = await addToolBinding(tool, undefined, addKbSel[tool] || null);
      if (b) await syncBinding(b);
      await refresh();
    } finally { cloudBusy = false; }
  }

  async function handleSyncBinding(b: MemoryBinding) {
    if (cloudBusy) return;
    cloudBusy = true;
    try { await syncBinding(b); } finally { cloudBusy = false; }
  }

  async function handleRestoreBinding(b: MemoryBinding) {
    if (cloudBusy) return;
    cloudBusy = true;
    try { await restoreBinding(b); } finally { cloudBusy = false; }
  }

  async function handleRerouteBinding(b: MemoryBinding, kbId: string) {
    if (cloudBusy || (b.kbId ?? '') === kbId) return;
    cloudBusy = true;
    try { await routeBindingToKb(b, kbId || null); await refresh(); } finally { cloudBusy = false; }
  }

  async function handleUnbind(mountAs: string) {
    await removeBinding(mountAs);
    await refresh();
  }

  function recomputeHealth() {
    healthReport = memories.length > 0 ? runHealthCheck(memories, { halfLife }) : null;
  }

  let filteredMemories = $derived(
    memories.filter((m) => {
      if (m.status === 'deleted') return false;
      if (selectedKind !== 'all' && m.kind !== selectedKind) return false;
      if (searchQuery.trim()) return m.content.toLowerCase().includes(searchQuery.toLowerCase());
      return true;
    }),
  );

  async function handleHalfLifeChange(v: unknown) {
    halfLife = v as MemoryHalfLife;
    await setHalfLife(halfLife);
    recomputeHealth();
  }

  function handleEdit(m: MemoryDoc) { editingId = m.id; editContent = m.content; }
  function cancelEdit() { editingId = null; editContent = ''; }
  async function saveEdit() {
    const id = editingId;
    if (!id) return;
    await updateMemoryContent(id, editContent);
    editingId = null; editContent = '';
    await refresh();
  }
  async function handleDelete(id: string) { await deleteMemory(id); await refresh(); }
  async function handleToggle(m: MemoryDoc) { await toggleMemory(m); await refresh(); }
  async function handleResetAll() {
    if (resetConfirmText !== 'RESET') return;
    await resetAllMemories();
    confirmResetOpen = false; resetConfirmText = '';
    await refresh();
  }

  function kindLabel(kind: MemoryDoc['kind']): string {
    return kind === 'preference' ? $t('memory.kind_preference')
      : kind === 'project' ? $t('memory.kind_project') : $t('memory.kind_fact');
  }
  function sensitivityLabel(s: MemoryDoc['sensitivity']): string {
    return $t(`memory.sensitivity_${s}`);
  }
  function healthMessage(issue: HealthIssue): string {
    const params = Object.fromEntries(Object.entries(issue.params).map(([k, v]) => [k, String(v)]));
    return $t(`memory.health_${issue.type}`, params);
  }

  // ── Cloud sync handlers ─────────────────────────────────────────────────

  async function persistCloud() { await memoryStore.setCloudConfig(cloud); }

  async function handleToggleSync() {
    cloud = { ...cloud, enabled: !cloud.enabled };
    await persistCloud();
    if (cloud.enabled && cloud.targetId) void handleSyncNow();
  }

  async function handleTargetChange(v: unknown) {
    cloud = { ...cloud, targetId: (v as string) ?? null };
    await persistCloud();
    if (cloud.enabled && cloud.targetId) void handleSyncNow();
  }

  async function handleSyncNow() {
    if (cloudBusy) return;
    cloudBusy = true;
    try { await syncNow(); await refresh(); } finally { cloudBusy = false; }
  }

  async function handleClearCloud() {
    if (clearCloudText !== 'CLEAR') return;
    cloudBusy = true;
    try { await clearRemoteMemories(); } finally {
      cloudBusy = false; confirmClearCloudOpen = false; clearCloudText = '';
    }
  }

  const syncStateLabelKey: Record<MemorySyncStatusKind, string> = {
    idle: 'memory.sync_state_idle',
    syncing: 'memory.sync_state_syncing',
    offline: 'memory.sync_state_offline',
    error: 'memory.sync_state_error',
    disabled: 'memory.sync_state_disabled',
  };

  // ── Export / import (Tauri dialog + fs) ─────────────────────────────────

  async function handleExport() {
    try {
      const docs = await memoryStore.getAll(true);
      const json = JSON.stringify({ version: 1, memories: docs }, null, 2);
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({ defaultPath: 'moraya-memories.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!path) return;
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      await writeTextFile(path, json);
    } catch (e) { console.warn('memory export failed', e); }
  }

  async function handleImport() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({ multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!path || typeof path !== 'string') return;
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const raw = await readTextFile(path);
      const data = JSON.parse(raw) as { memories?: unknown };
      if (!Array.isArray(data.memories)) return;
      for (const d of data.memories as MemoryDoc[]) {
        if (d && typeof d.id === 'string' && typeof d.content === 'string') await memoryStore.put(d);
      }
      await refresh();
    } catch (e) { console.warn('memory import failed', e); }
  }
</script>

<div class="memory-settings gx-tab">
  <!-- Health report -->
  {#if healthReport && healthReport.issues.length > 0}
    <section class="settings-section">
      <div class="section-header">
        <h3 class="section-title">{$t('memory.health_title')}</h3>
      </div>
      <div class="card">
        {#each healthReport.issues as issue}
          <div class="health-issue">{healthMessage(issue)}</div>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Settings -->
  <section class="settings-section">
    <div class="section-header">
      <h3 class="section-title">{$t('memory.settings_title')}</h3>
    </div>
    <div class="card">
      <div class="row">
        <span class="row-label">{$t('memory.half_life_label')}</span>
        <Select value={halfLife} options={halfLifeOptions} onchange={handleHalfLifeChange} ariaLabel={$t('memory.half_life_label')} />
      </div>
    </div>
    <div class="io-row">
      <button class="ghost-btn" onclick={handleExport}>{$t('memory.export_btn')}</button>
      <button class="ghost-btn" onclick={handleImport}>{$t('memory.import_btn')}</button>
    </div>
  </section>

  <!-- Cloud sync -->
  <section class="settings-section">
    <div class="section-header">
      <h3 class="section-title">{$t('memory.cloud_sync_title')}</h3>
      <p class="section-subtitle">{$t('memory.cloud_sync_desc')}</p>
    </div>
    <div class="card">
      {#if picoraTargets.length === 0}
        <p class="empty-hint">{$t('kb_sync.bind_dialog.no_picora')}</p>
      {:else}
        <div class="row">
          <span class="row-label">{$t('memory.cloud_sync_enable')}</span>
          <button
            type="button" class="toggle" class:on={cloud.enabled}
            role="switch" aria-checked={cloud.enabled}
            aria-label={$t('memory.cloud_sync_enable')} onclick={handleToggleSync}
          ><span class="thumb"></span></button>
        </div>
        {#if cloud.enabled}
          {#if picoraTargets.length > 1}
            <div class="row">
              <span class="row-label">{$t('kb_sync.bind_dialog.step1_title')}</span>
              <Select value={cloud.targetId} options={targetOptions} onchange={handleTargetChange} placeholder={$t('kb_sync.bind_dialog.step1_title')} ariaLabel={$t('kb_sync.bind_dialog.step1_title')} />
            </div>
          {/if}
          <div class="row">
            <span class="row-label">{$t(syncStateLabelKey[syncState])}</span>
            <button class="ghost-btn" onclick={handleSyncNow} disabled={cloudBusy || !cloud.targetId}>{$t('memory.sync_now')}</button>
          </div>
        {/if}
      {/if}
    </div>
    {#if cloud.enabled && cloud.targetId}
      <div class="card danger-card">
        {#if !confirmClearCloudOpen}
          <button class="danger-btn" onclick={() => (confirmClearCloudOpen = true)} disabled={cloudBusy}>{$t('memory.clear_cloud')}</button>
        {:else}
          <p class="hint">{$t('memory.clear_cloud_confirm')}</p>
          <input type="text" bind:value={clearCloudText} placeholder="CLEAR" class="confirm-input" />
          <div class="confirm-actions">
            <button class="danger-btn" onclick={handleClearCloud} disabled={clearCloudText !== 'CLEAR' || cloudBusy}>{$t('memory.clear_cloud')}</button>
            <button class="cancel-btn" onclick={() => { confirmClearCloudOpen = false; clearCloudText = ''; }}>{$t('memory.cancel')}</button>
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- Tool memory bindings (P2) — always visible so the entry is discoverable -->
  <section class="settings-section">
    <div class="section-header">
      <h3 class="section-title">{$t('memory.bindings_title')}</h3>
      <p class="section-subtitle">{$t('memory.bindings_desc')}</p>
    </div>
    <div class="card">
      {#if picoraTargets.length === 0}
        <p class="empty-hint">{$t('memory.cloud_sync_signin_hint')}</p>
      {:else}
        <!-- Existing bindings: show target KB, allow re-routing -->
        {#each bindings as b (b.mountAs)}
          <div class="row binding-row">
            <span class="binding-info"><strong>{b.tool}</strong> <code>{b.externalPath} → {b.mountAs}/</code> · {kbLabel(b.kbId)}</span>
            <div class="binding-actions">
              <Select value={b.kbId ?? ''} options={kbOptions} onchange={(v) => handleRerouteBinding(b, v as string)} ariaLabel={$t('memory.bind_to_kb')} />
              <button class="ghost-btn" onclick={() => handleSyncBinding(b)} disabled={cloudBusy}>{$t('memory.sync_now')}</button>
              <button class="ghost-btn" onclick={() => handleRestoreBinding(b)} disabled={cloudBusy}>{$t('memory.restore')}</button>
              <button class="cancel-btn" onclick={() => handleUnbind(b.mountAs)} disabled={cloudBusy}>{$t('memory.unbind')}</button>
            </div>
          </div>
        {/each}
        <!-- Bindable tools detected locally: pick a target KB, then bind -->
        {#each bindableTools as tool (tool)}
          <div class="row binding-row">
            <span class="binding-info"><strong>{tool}</strong> <span class="row-label">{$t('memory.bind_to_kb')}</span></span>
            <div class="binding-actions">
              <Select value={addKbSel[tool] ?? ''} options={kbOptions} onchange={(v) => (addKbSel = { ...addKbSel, [tool]: v as string })} ariaLabel={$t('memory.bind_to_kb')} />
              <button class="ghost-btn" onclick={() => handleBindTool(tool)} disabled={cloudBusy}>{$t('memory.bind')}</button>
            </div>
          </div>
        {/each}
        {#if bindings.length === 0 && bindableTools.length === 0}
          <p class="empty-hint">{$t('memory.bindings_none_detected')}</p>
        {/if}
      {/if}
    </div>
  </section>

  <!-- Memory list -->
  <section class="settings-section">
    <div class="section-header list-header">
      <h3 class="section-title">{$t('memory.memories_title')}</h3>
      <span class="count-pill">{filteredMemories.length}</span>
    </div>
    <div class="filters">
      <input type="search" class="search-input" bind:value={searchQuery} placeholder={$t('memory.search_placeholder')} />
      <Select value={selectedKind} options={kindOptions} onchange={(v) => (selectedKind = v as typeof selectedKind)} ariaLabel={$t('memory.filter_all')} />
    </div>

    {#if filteredMemories.length === 0}
      <div class="card"><p class="empty-hint">{$t('memory.no_memories')}</p></div>
    {:else}
      <div class="memory-list">
        {#each filteredMemories as m (m.id)}
          <div class="card memory-card">
            <div class="card-header">
              <span class="pill muted">{kindLabel(m.kind)}</span>
              <span class="pill sensitivity {m.sensitivity}">{sensitivityLabel(m.sensitivity)}</span>
              <div class="card-actions">
                <button class="icon-btn" onclick={() => handleEdit(m)} title={$t('memory.edit')} aria-label={$t('memory.edit')}>✎</button>
                <button class="icon-btn" class:on={m.status === 'active'} onclick={() => handleToggle(m)} title={m.status === 'active' ? $t('memory.disable') : $t('memory.enable')} aria-label={m.status === 'active' ? $t('memory.disable') : $t('memory.enable')}>⏻</button>
                <button class="icon-btn" onclick={() => handleDelete(m.id)} title={$t('memory.delete')} aria-label={$t('memory.delete')}>✕</button>
              </div>
            </div>
            {#if editingId === m.id}
              <div class="edit-area">
                <textarea class="edit-textarea" bind:value={editContent} rows="3" maxlength="200"></textarea>
                <div class="edit-actions">
                  <button class="save-btn" onclick={saveEdit}>{$t('memory.save')}</button>
                  <button class="cancel-btn" onclick={cancelEdit}>{$t('memory.cancel')}</button>
                </div>
              </div>
            {:else}
              <p class="memory-content">{m.content}</p>
            {/if}
            <div class="card-footer">
              <span class="meta">{$t('memory.weight')}: {m.weight.toFixed(2)}</span>
              <span class="meta">{new Date(m.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Danger zone -->
  <section class="settings-section">
    <div class="section-header">
      <h3 class="section-title">{$t('memory.danger_zone')}</h3>
    </div>
    <div class="card danger-card">
      {#if !confirmResetOpen}
        <button class="danger-btn" onclick={() => (confirmResetOpen = true)}>{$t('memory.reset_all')}</button>
      {:else}
        <p class="hint">{$t('memory.reset_confirm_instruction')}</p>
        <input type="text" bind:value={resetConfirmText} placeholder="RESET" class="confirm-input" />
        <div class="confirm-actions">
          <button class="danger-btn" onclick={handleResetAll} disabled={resetConfirmText !== 'RESET'}>{$t('memory.confirm_reset')}</button>
          <button class="cancel-btn" onclick={() => { confirmResetOpen = false; resetConfirmText = ''; }}>{$t('memory.cancel')}</button>
        </div>
      {/if}
    </div>
  </section>
</div>

<style>
  .memory-settings { display: flex; flex-direction: column; gap: 1.5rem; }
  .settings-section { display: flex; flex-direction: column; gap: 0.5rem; }
  .section-header { display: flex; flex-direction: column; gap: 0.15rem; }
  .list-header { flex-direction: row; align-items: center; gap: 0.5rem; }
  .section-title { font-size: 0.95rem; font-weight: 600; margin: 0; color: var(--text-primary); }
  .section-subtitle { font-size: 0.8rem; color: var(--text-secondary); margin: 0; }
  .card {
    background: var(--bg-secondary); border: 1px solid var(--border-color);
    border-radius: 8px; padding: 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.6rem;
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .row-label { font-size: 0.85rem; color: var(--text-primary); }
  .io-row, .filters { display: flex; gap: 0.5rem; }
  .filters { margin-top: 0.25rem; }
  .search-input, .confirm-input {
    flex: 1; padding: 0.4rem 0.6rem; border: 1px solid var(--border-color);
    border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font-size: 0.85rem;
  }
  .confirm-input { max-width: 160px; }
  .count-pill { background: var(--accent-color); color: #fff; border-radius: 10px; padding: 0 0.5rem; font-size: 0.75rem; }
  .memory-list { display: flex; flex-direction: column; gap: 0.4rem; }
  .memory-card { gap: 0.5rem; }
  .card-header { display: flex; align-items: center; gap: 0.4rem; }
  .card-actions { margin-left: auto; display: flex; gap: 0.2rem; }
  .icon-btn {
    width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: 5px; color: var(--text-muted); cursor: pointer;
  }
  .icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .icon-btn.on { color: var(--accent-color); }
  .pill { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 10px; }
  .pill.muted { background: var(--bg-hover); color: var(--text-secondary); }
  .pill.sensitivity.low { background: rgba(40,167,69,0.15); color: #28a745; }
  .pill.sensitivity.medium { background: rgba(255,193,7,0.15); color: #d39e00; }
  .pill.sensitivity.high { background: rgba(220,53,69,0.15); color: #dc3545; }
  .memory-content { margin: 0; font-size: 0.85rem; line-height: 1.5; color: var(--text-primary); }
  .edit-area { display: flex; flex-direction: column; gap: 0.5rem; }
  .edit-textarea {
    resize: vertical; font-size: 0.85rem; padding: 0.5rem; border: 1px solid var(--border-color);
    border-radius: 6px; background: var(--bg-primary); color: var(--text-primary);
  }
  .edit-actions, .confirm-actions { display: flex; gap: 0.5rem; }
  .card-footer { display: flex; gap: 1rem; }
  .meta { font-size: 0.7rem; color: var(--text-secondary); }
  .health-issue { font-size: 0.78rem; color: var(--text-secondary); padding: 0.15rem 0; }
  .empty-hint, .hint { font-size: 0.82rem; color: var(--text-secondary); margin: 0; }
  .ghost-btn, .cancel-btn, .save-btn, .danger-btn {
    padding: 0.35rem 0.75rem; border-radius: 6px; font-size: 0.82rem; cursor: pointer; border: 1px solid var(--border-color);
  }
  .ghost-btn, .cancel-btn { background: var(--bg-primary); color: var(--text-primary); }
  .save-btn { background: var(--accent-color); color: #fff; border-color: transparent; }
  .danger-btn { background: #dc3545; color: #fff; border-color: transparent; align-self: flex-start; }
  .danger-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .toggle {
    width: 40px; height: 22px; border-radius: 11px; background: var(--border-color); border: none;
    position: relative; cursor: pointer; padding: 0; transition: background 0.15s;
  }
  .toggle.on { background: var(--accent-color); }
  .toggle .thumb {
    position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
    background: #fff; transition: transform 0.15s;
  }
  .toggle.on .thumb { transform: translateX(18px); }
  .binding-row { align-items: center; }
  .binding-info { font-size: 0.82rem; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; }
  .binding-info code { font-size: 0.72rem; color: var(--text-secondary); }
  .binding-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
</style>
