<script lang="ts">
  import { onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import { filesStore } from '$lib/stores/files-store';
  import { normalizePlanKey, getFallbackPlanLimits, type PlanLimits } from '$lib/services/picora';
  import {
    PICORA_DEFAULT_API_BASE,
    type ImageHostTarget,
  } from '$lib/services/image-hosting';

  let { onOpenImport, onJumpToKbSync }: {
    onOpenImport: () => void;
    onJumpToKbSync?: () => void;
  } = $props();

  const tr = $t;

  let targets = $state<ImageHostTarget[]>([]);
  let defaultPicoraId = $state('');
  let defaultImageHostId = $state('');
  let kbBindingsByTargetId = $state<Map<string, number>>(new Map());

  const unsubSettings = settingsStore.subscribe(state => {
    targets = state.imageHostTargets || [];
    defaultPicoraId = state.defaultPicoraAccountId || '';
    defaultImageHostId = state.defaultImageHostId || '';
  });
  const unsubFiles = filesStore.subscribe(state => {
    const counts = new Map<string, number>();
    for (const kb of state.knowledgeBases) {
      const tid = kb.picoraBinding?.picoraTargetId;
      if (tid) counts.set(tid, (counts.get(tid) ?? 0) + 1);
    }
    kbBindingsByTargetId = counts;
  });
  onDestroy(() => { unsubSettings(); unsubFiles(); });

  let picoraTargets = $derived(
    [...targets].filter(t => t.provider === 'picora').sort((a, b) => {
      const aDef = a.id === defaultPicoraId ? 0 : 1;
      const bDef = b.id === defaultPicoraId ? 0 : 1;
      if (aDef !== bDef) return aDef - bDef;
      return (b.picoraImportedAt ?? 0) - (a.picoraImportedAt ?? 0);
    })
  );

  // ── Quota cache (per target) ─────────────────────────────────────────

  interface QuotaState {
    loading: boolean;
    error: string | null;
    data: {
      plan: string;
      planLimits: PlanLimits | null;
      images: { storageUsed?: number; uploadCountMonth?: number; totalCount?: number; publicCount?: number; privateCount?: number } | null;
      docs: { totalCount?: number; storageUsed?: number } | null;
      audio: { totalCount?: number; storageUsed?: number } | null;
      videos: { totalCount?: number; storageUsed?: number; bandwidthUsed?: number } | null;
      kbs: { totalCount?: number } | null;
      updatedAt: string | null;
      usageV2: boolean;
    } | null;
    fetchedAt: number;
  }

  let quotaByTargetId = $state<Record<string, QuotaState>>({});

  function picoraApiBase(target: ImageHostTarget): string {
    const url = (target.picoraApiUrl || '').trim();
    if (!url) return PICORA_DEFAULT_API_BASE;
    return url.replace(/\/v1\/images\/?$/, '').replace(/\/$/, '') || PICORA_DEFAULT_API_BASE;
  }

  async function fetchQuota(target: ImageHostTarget) {
    quotaByTargetId[target.id] = {
      ...(quotaByTargetId[target.id] ?? { data: null, fetchedAt: 0, error: null, loading: false }),
      loading: true,
      error: null,
    };
    quotaByTargetId = { ...quotaByTargetId };
    try {
      const apiBase = picoraApiBase(target);
      const { getPicoraApiKeyOrEmpty } = await import('$lib/services/picora/credentials');
      const apiKey = await getPicoraApiKeyOrEmpty(target);
      const data = await invoke<{
        plan: string;
        planLimits: PlanLimits | null;
        images: QuotaState['data'] extends infer D ? (D extends { images: infer I } ? I : never) : never;
        docs: unknown;
        audio: unknown;
        videos: unknown;
        kbs: unknown;
        updatedAt: string | null;
        usageV2: boolean;
      }>('picora_get_quota', { apiBase, apiKey });
      const planLimits = data.planLimits ?? getFallbackPlanLimits(data.plan);
      quotaByTargetId[target.id] = {
        loading: false,
        error: null,
        data: {
          plan: data.plan,
          planLimits,
          images: (data.images as QuotaState['data'] extends infer D ? D extends { images: infer I } ? I : never : never) ?? null,
          docs: (data.docs as { totalCount?: number; storageUsed?: number } | null) ?? null,
          audio: (data.audio as { totalCount?: number; storageUsed?: number } | null) ?? null,
          videos: (data.videos as { totalCount?: number; storageUsed?: number; bandwidthUsed?: number } | null) ?? null,
          kbs: (data.kbs as { totalCount?: number } | null) ?? null,
          updatedAt: data.updatedAt,
          usageV2: data.usageV2,
        },
        fetchedAt: Date.now(),
      };
    } catch (e) {
      quotaByTargetId[target.id] = {
        ...(quotaByTargetId[target.id] ?? { data: null, fetchedAt: 0 }),
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    quotaByTargetId = { ...quotaByTargetId };
  }

  // Auto-fetch quota for visible targets after first render
  $effect(() => {
    for (const target of picoraTargets) {
      if (!quotaByTargetId[target.id]) {
        // Schedule but don't await — UI renders immediately
        setTimeout(() => fetchQuota(target), 0);
      }
    }
  });

  // ── Test connection ─────────────────────────────────────────────────

  let testStatus = $state<Record<string, 'idle' | 'testing' | 'success' | 'failed'>>({});
  let testError = $state<Record<string, string>>({});

  async function testConnection(target: ImageHostTarget) {
    testStatus[target.id] = 'testing';
    testError[target.id] = '';
    testStatus = { ...testStatus };
    try {
      const { getPicoraApiKeyOrEmpty } = await import('$lib/services/picora/credentials');
      await invoke('test_picora_connection', {
        apiBase: picoraApiBase(target),
        apiKey: await getPicoraApiKeyOrEmpty(target),
      });
      testStatus[target.id] = 'success';
    } catch (e) {
      testStatus[target.id] = 'failed';
      testError[target.id] = e instanceof Error ? e.message : String(e);
    }
    testStatus = { ...testStatus };
    setTimeout(() => {
      testStatus[target.id] = 'idle';
      testStatus = { ...testStatus };
    }, 5000);
  }

  // ── Set default ──────────────────────────────────────────────────────

  function setDefault(id: string) {
    settingsStore.setDefaultPicoraAccount(id);
  }

  // ── Edit ─────────────────────────────────────────────────────────────

  let editing = $state<ImageHostTarget | null>(null);

  function startEdit(target: ImageHostTarget) {
    editing = JSON.parse(JSON.stringify(target));
  }

  function cancelEdit() {
    editing = null;
  }

  async function saveEdit() {
    if (!editing) return;
    // v0.69.0: push entered API key into OS keychain and clear the inline
    // field before persisting to disk.
    if (editing.picoraApiKey) {
      try {
        const { setPicoraApiKey } = await import('$lib/services/picora/credentials');
        await setPicoraApiKey(editing.id, editing.picoraApiKey);
        editing = { ...editing, picoraApiKey: '', picoraKeyMigratedV069: true };
      } catch {
        // Keychain unavailable — fall back to inline storage.
      }
    }
    const updated = targets.map(t => t.id === editing!.id ? editing! : t);
    settingsStore.update({ imageHostTargets: JSON.parse(JSON.stringify(updated)) });
    editing = null;
  }

  // ── Remove ───────────────────────────────────────────────────────────

  let removing = $state<ImageHostTarget | null>(null);

  function startRemove(target: ImageHostTarget) {
    removing = target;
  }

  function confirmRemove() {
    if (!removing) return;
    const target = removing;
    const remaining = targets.filter(t => t.id !== target.id);
    const patch: Record<string, unknown> = {
      imageHostTargets: JSON.parse(JSON.stringify(remaining)),
    };
    if (target.id === defaultPicoraId) {
      // Pick earliest imported remaining Picora target as new default
      const remainingPicora = remaining.filter(t => t.provider === 'picora');
      const newDefault = remainingPicora.length > 0
        ? [...remainingPicora].sort((a, b) => (a.picoraImportedAt ?? 0) - (b.picoraImportedAt ?? 0))[0]
        : null;
      patch.defaultPicoraAccountId = newDefault?.id ?? '';
    }
    if (target.id === defaultImageHostId) {
      patch.defaultImageHostId = remaining.length > 0 ? remaining[0].id : '';
    }
    settingsStore.update(patch);
    // Clear KB bindings referencing this target
    const fs = filesStore.getState();
    for (const kb of fs.knowledgeBases) {
      if (kb.picoraBinding?.picoraTargetId === target.id) {
        filesStore.clearKbBinding(kb.id);
      }
    }
    removing = null;
  }

  function cancelRemove() { removing = null; }

  // ── Formatters ───────────────────────────────────────────────────────

  function fmtBytes(b: number | undefined): string {
    if (b === undefined || b === null) return '-';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function fmtPercent(used: number, total: number): number {
    if (total <= 0) return 0;
    return Math.min(100, Math.round((used / total) * 100));
  }

  function progressClass(pct: number): string {
    if (pct >= 95) return 'red';
    if (pct >= 80) return 'orange';
    if (pct >= 50) return 'yellow';
    return 'green';
  }

  function fmtUpdated(iso: string | null): string {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch { return ''; }
  }

  function planLabel(plan: string): string {
    const p = normalizePlanKey(plan);
    return p.isKnown ? tr(p.i18nKey) : p.raw;
  }

  function planBadgeClass(plan: string): string {
    return `plan-${normalizePlanKey(plan).color}`;
  }
</script>

<section class="picora-account-section">
  <header class="section-header">
    <h3>{tr('settings.picora.account.title')}</h3>
    <button class="btn-add" onclick={onOpenImport}>+ {tr('settings.picora.account.add')}</button>
  </header>

  {#if picoraTargets.length === 0}
    <div class="empty-state">
      <p>{tr('settings.picora.account.empty')}</p>
      <button class="btn-primary" onclick={onOpenImport}>{tr('settings.picora.account.addFirst')}</button>
    </div>
  {:else}
    <div class="account-list">
      {#each picoraTargets as target (target.id)}
        {@const inUseCount = kbBindingsByTargetId.get(target.id) ?? 0}
        {@const quota = quotaByTargetId[target.id]}
        <div class="account-card" class:is-default={target.id === defaultPicoraId}>
          <div class="card-head">
            <div class="title-row">
              {#if target.id === defaultPicoraId}<span class="star">★</span>{/if}
              <span class="email">{target.picoraUserEmail || tr('settings.picora.account.unknownEmail')}</span>
              {#if quota?.data}
                <span class="plan-badge {planBadgeClass(quota.data.plan)}">{planLabel(quota.data.plan)}</span>
              {/if}
              <span class="endpoint">{target.picoraApiUrl || tr('settings.picora.account.noEndpoint')}</span>
              {#if inUseCount > 0}
                <span class="in-use-badge">{tr('settings.picora.account.inUse', { n: String(inUseCount) })}</span>
              {/if}
            </div>
            <div class="actions">
              {#if target.id !== defaultPicoraId}
                <button class="action-btn" onclick={() => setDefault(target.id)} title={tr('settings.picora.account.setDefault')}>★</button>
              {/if}
              <button
                class="action-btn"
                class:testing={testStatus[target.id] === 'testing'}
                class:success={testStatus[target.id] === 'success'}
                class:failed={testStatus[target.id] === 'failed'}
                onclick={() => testConnection(target)}
                disabled={testStatus[target.id] === 'testing'}
                title={tr('settings.picora.account.test')}
              >
                {#if testStatus[target.id] === 'testing'}…
                {:else if testStatus[target.id] === 'success'}✓
                {:else if testStatus[target.id] === 'failed'}✗
                {:else}🔍{/if}
              </button>
              <button class="action-btn" onclick={() => startEdit(target)} title={tr('settings.picora.account.edit')}>✎</button>
              <button class="action-btn danger" onclick={() => startRemove(target)} title={tr('settings.picora.account.remove')}>🗑</button>
            </div>
          </div>

          {#if testError[target.id] && testStatus[target.id] === 'failed'}
            <p class="error-line">{testError[target.id]}</p>
          {/if}

          <!-- Quota -->
          <div class="quota-block">
            <div class="quota-head">
              <span class="quota-title">{tr('settings.picora.account.quota')}</span>
              {#if quota?.data?.updatedAt}
                <span class="quota-time">{fmtUpdated(quota.data.updatedAt)}</span>
              {/if}
              <button class="quota-refresh" onclick={() => fetchQuota(target)} disabled={quota?.loading}>↻</button>
            </div>

            {#if quota?.loading && !quota.data}
              <div class="quota-loading">{tr('settings.picora.account.quotaLoading')}</div>
            {:else if quota?.error && !quota.data}
              <div class="quota-error">{tr('settings.picora.account.quotaUnavailable')}</div>
            {:else if quota?.data}
              {@const d = quota.data}
              {@const limits = d.planLimits ?? getFallbackPlanLimits(d.plan)}
              {#if d.plan === 'none' && (limits.imgStorageBytes === 0)}
                <div class="cta-card">
                  <p>{tr('settings.picora.account.notActivated')}</p>
                  <a href="https://center.picora.me" target="_blank" rel="noreferrer">{tr('settings.picora.account.activate')} ↗</a>
                </div>
              {:else}
                <div class="quota-rows">
                  <div class="quota-row">
                    <span class="row-label">{tr('settings.picora.quota.images')}</span>
                    {#if d.images === null}
                      <span class="row-na" title={tr('settings.picora.account.dataPointNa')}>-</span>
                    {:else}
                      {@const used = d.images.storageUsed ?? 0}
                      {@const pct = fmtPercent(used, limits.imgStorageBytes)}
                      <div class="bar"><div class="bar-fill {progressClass(pct)}" style="width:{pct}%"></div></div>
                      <span class="row-info">{fmtBytes(used)} / {fmtBytes(limits.imgStorageBytes)}</span>
                    {/if}
                  </div>
                  <div class="quota-row">
                    <span class="row-label">{tr('settings.picora.quota.docs')}</span>
                    {#if d.docs === null}
                      <span class="row-na" title={d.usageV2 ? tr('settings.picora.account.dataPointNa') : tr('settings.picora.account.needsPicoraV017')}>-</span>
                    {:else}
                      {@const used = d.docs.totalCount ?? 0}
                      {@const pct = fmtPercent(used, limits.docCount)}
                      <div class="bar"><div class="bar-fill {progressClass(pct)}" style="width:{pct}%"></div></div>
                      <span class="row-info">{used} / {limits.docCount}</span>
                    {/if}
                  </div>
                  <div class="quota-row">
                    <span class="row-label">{tr('settings.picora.quota.audio')}</span>
                    {#if d.audio === null}
                      <span class="row-na" title={d.usageV2 ? tr('settings.picora.account.dataPointNa') : tr('settings.picora.account.needsPicoraV017')}>-</span>
                    {:else}
                      {@const used = d.audio.storageUsed ?? 0}
                      {@const pct = fmtPercent(used, limits.audioStorageBytes)}
                      <div class="bar"><div class="bar-fill {progressClass(pct)}" style="width:{pct}%"></div></div>
                      <span class="row-info">{fmtBytes(used)} / {fmtBytes(limits.audioStorageBytes)}</span>
                    {/if}
                  </div>
                  <div class="quota-row">
                    <span class="row-label">{tr('settings.picora.quota.videos')}</span>
                    {#if d.videos === null}
                      <span class="row-na" title={tr('settings.picora.account.dataPointNa')}>-</span>
                    {:else}
                      {@const used = d.videos.storageUsed ?? 0}
                      {@const pct = fmtPercent(used, limits.videoStorageBytes)}
                      <div class="bar"><div class="bar-fill {progressClass(pct)}" style="width:{pct}%"></div></div>
                      <span class="row-info">{fmtBytes(used)} / {fmtBytes(limits.videoStorageBytes)}</span>
                    {/if}
                  </div>
                  <div class="quota-row">
                    <span class="row-label">{tr('settings.picora.quota.kbs')}</span>
                    {#if d.kbs === null}
                      <span class="row-na" title={d.usageV2 ? tr('settings.picora.account.dataPointNa') : tr('settings.picora.account.needsPicoraV017')}>-</span>
                    {:else}
                      {@const used = d.kbs.totalCount ?? 0}
                      {@const pct = fmtPercent(used, limits.kbCount)}
                      <div class="bar"><div class="bar-fill {progressClass(pct)}" style="width:{pct}%"></div></div>
                      <span class="row-info">{used} / {limits.kbCount}</span>
                    {/if}
                  </div>
                </div>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

{#if editing}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="modal-overlay" role="dialog" aria-modal="true">
    <div class="modal">
      <h4>{tr('settings.picora.editTitle')}</h4>
      <div class="field">
        <label for="picora-edit-name">{tr('imageHost.targetName')}</label>
        <input id="picora-edit-name" type="text" bind:value={editing.name} />
      </div>
      <div class="field">
        <label for="picora-edit-api">{tr('imageHost.picoraApiUrl')}</label>
        <input id="picora-edit-api" type="text" bind:value={editing.picoraApiUrl} />
      </div>
      <div class="field">
        <label for="picora-edit-img">{tr('imageHost.picoraImgDomain')}</label>
        <input id="picora-edit-img" type="text" bind:value={editing.picoraImgDomain} />
      </div>
      <div class="field">
        <label for="picora-edit-key">{tr('imageHost.picoraApiKey')}</label>
        <input id="picora-edit-key" type="password"
          bind:value={editing.picoraApiKey}
          placeholder={editing.picoraKeyMigratedV069 ? tr('imageHost.picoraApiKeyKeychain') : ''} />
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick={cancelEdit}>{tr('common.cancel')}</button>
        <button class="btn-primary" onclick={saveEdit}>{tr('common.save')}</button>
      </div>
    </div>
  </div>
{/if}

{#if removing}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="modal-overlay" role="dialog" aria-modal="true">
    <div class="modal">
      <h4>⚠ {tr('settings.picora.account.removeConfirmTitle')}</h4>
      <p>{tr('settings.picora.account.removeConfirmBody', { email: removing.picoraUserEmail || removing.name })}</p>
      <ul class="cascade-list">
        {#if removing.id === defaultPicoraId}
          <li>{tr('settings.picora.account.cascadeDefault')}</li>
        {/if}
        {#if removing.id === defaultImageHostId}
          <li>{tr('settings.picora.account.cascadeImageHost')}</li>
        {/if}
        {#if (kbBindingsByTargetId.get(removing.id) ?? 0) > 0}
          <li>{tr('settings.picora.account.cascadeKbBindings', { n: String(kbBindingsByTargetId.get(removing.id) ?? 0) })}</li>
        {/if}
      </ul>
      <p class="cloud-data-note">{tr('settings.picora.account.cloudDataPreserved')}</p>
      <div class="modal-actions">
        <button class="btn-cancel" onclick={cancelRemove}>{tr('common.cancel')}</button>
        <button class="btn-danger" onclick={confirmRemove}>{tr('settings.picora.account.confirmRemove')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .picora-account-section { display: flex; flex-direction: column; gap: 0.75rem; }
  .section-header { display: flex; align-items: center; justify-content: space-between; }
  .section-header h3 { margin: 0; font-size: var(--font-size-base); font-weight: 600; color: var(--text-primary); }

  .btn-add {
    padding: 0.3rem 0.7rem;
    font-size: var(--font-size-sm);
    background: transparent;
    border: 1px solid var(--accent-color);
    color: var(--accent-color);
    border-radius: 4px;
    cursor: pointer;
  }
  .btn-add:hover { background: var(--accent-color); color: #fff; }

  .empty-state { padding: 1.5rem; text-align: center; color: var(--text-muted); }
  .empty-state p { margin: 0 0 0.75rem 0; font-size: var(--font-size-sm); }

  .btn-primary {
    padding: 0.4rem 0.9rem;
    background: var(--accent-color);
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-sm);
  }
  .btn-cancel {
    padding: 0.3rem 0.8rem;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .btn-danger {
    padding: 0.3rem 0.8rem;
    background: #dc3545;
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-sm);
  }

  .account-list { display: flex; flex-direction: column; gap: 0.5rem; }

  .account-card {
    border: 1px solid var(--border-light);
    border-left: 3px solid var(--border-color);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .account-card.is-default { border-left-color: var(--accent-color); }

  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .title-row { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; min-width: 0; }
  .star { color: var(--accent-color); }
  .email { font-size: var(--font-size-sm); font-weight: 500; color: var(--text-primary); }
  .endpoint { font-size: var(--font-size-xs); color: var(--text-muted); font-family: var(--font-mono, monospace); }
  .plan-badge {
    font-size: var(--font-size-xs);
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    font-weight: 600;
  }
  .plan-gray { background: color-mix(in srgb, #888 20%, transparent); color: var(--text-secondary); }
  .plan-blue { background: color-mix(in srgb, #3b82f6 20%, transparent); color: #3b82f6; }
  .plan-purple { background: color-mix(in srgb, #8b5cf6 20%, transparent); color: #8b5cf6; }
  .plan-gold { background: color-mix(in srgb, #f59e0b 20%, transparent); color: #d97706; }

  .in-use-badge {
    font-size: var(--font-size-xs);
    color: var(--accent-color);
    background: color-mix(in srgb, var(--accent-color) 12%, transparent);
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
  }

  .actions { display: flex; gap: 0.25rem; }
  .action-btn {
    width: 1.7rem; height: 1.7rem;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border-light);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.75rem;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .action-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .action-btn.danger:hover { color: #dc3545; border-color: #dc3545; }
  .action-btn.testing { color: var(--accent-color); border-color: var(--accent-color); }
  .action-btn.success { color: #28a745; border-color: #28a745; }
  .action-btn.failed { color: #dc3545; border-color: #dc3545; }

  .error-line { margin: 0; font-size: var(--font-size-xs); color: #dc3545; word-break: break-all; }

  .quota-block { display: flex; flex-direction: column; gap: 0.3rem; }
  .quota-head { display: flex; align-items: center; gap: 0.5rem; font-size: var(--font-size-xs); color: var(--text-muted); }
  .quota-title { font-weight: 500; }
  .quota-time { font-style: italic; }
  .quota-refresh {
    margin-left: auto;
    background: transparent; border: none; cursor: pointer;
    color: var(--text-muted); font-size: 0.85rem;
  }
  .quota-refresh:hover { color: var(--accent-color); }
  .quota-loading, .quota-error { font-size: var(--font-size-xs); color: var(--text-muted); padding: 0.3rem 0; }

  .quota-rows { display: grid; grid-template-columns: max-content 1fr max-content; gap: 0.3rem 0.6rem; align-items: center; }
  .quota-row { display: contents; }
  .row-label { font-size: var(--font-size-xs); color: var(--text-muted); white-space: nowrap; }
  .row-info { font-size: var(--font-size-xs); color: var(--text-secondary); white-space: nowrap; }
  .row-na { font-size: var(--font-size-xs); color: var(--text-muted); grid-column: 2 / span 2; }
  .bar { height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; transition: width 0.2s ease; }
  .bar-fill.green { background: #28a745; }
  .bar-fill.yellow { background: #ffc107; }
  .bar-fill.orange { background: #fd7e14; }
  .bar-fill.red { background: #dc3545; }

  .cta-card {
    padding: 0.75rem;
    background: color-mix(in srgb, var(--accent-color) 8%, transparent);
    border: 1px dashed var(--accent-color);
    border-radius: 4px;
    text-align: center;
  }
  .cta-card p { margin: 0 0 0.4rem 0; font-size: var(--font-size-sm); color: var(--text-secondary); }
  .cta-card a { color: var(--accent-color); font-weight: 500; text-decoration: none; }
  .cta-card a:hover { text-decoration: underline; }

  /* Modal */
  .modal-overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 250;
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1.25rem;
    width: min(420px, 90vw);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    display: flex; flex-direction: column; gap: 0.75rem;
  }
  .modal h4 { margin: 0; font-size: var(--font-size-base); }
  .modal p { margin: 0; font-size: var(--font-size-sm); color: var(--text-secondary); }
  .modal .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .modal .field label { font-size: var(--font-size-xs); color: var(--text-muted); }
  .modal .field input {
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .cascade-list { margin: 0 0 0 1.25rem; padding: 0; font-size: var(--font-size-sm); color: var(--text-secondary); }
  .cloud-data-note { font-size: var(--font-size-xs); color: var(--text-muted); margin-top: 0.4rem; }
</style>
