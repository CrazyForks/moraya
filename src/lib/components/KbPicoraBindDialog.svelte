<script lang="ts">
  import { t } from '$lib/i18n';
  import { Select } from '$lib/components/ui';
  import { settingsStore } from '$lib/stores/settings-store';
  import { filesStore, type KnowledgeBase } from '$lib/stores/files-store';
  import { onDestroy } from 'svelte';
  import type { ImageHostTarget } from '$lib/services/image-hosting/types';
  import type { PicoraKb, KbBinding, SyncStrategy } from '$lib/services/kb-sync/types';
  import { DEFAULT_SYNC_STRATEGY } from '$lib/services/kb-sync/types';
  import { listKbs, createKb, picoraApiBase, dryRunSync } from '$lib/services/kb-sync/sync-service';
  import type { DiffResult } from '$lib/services/kb-sync/types';

  let { kb, onClose, onBound }: {
    kb: KnowledgeBase;
    onClose: () => void;
    onBound: (binding: KbBinding) => void;
  } = $props();

  let step = $state(1);
  let picoraTargets = $state<ImageHostTarget[]>([]);
  let selectedTargetId = $state('');
  let remoteKbs = $state<PicoraKb[]>([]);
  let loadingKbs = $state(false);
  let kbsError = $state('');
  // Default to linking an existing cloud KB (shown first in step 2).
  let createMode = $state(false);
  let newKbName = $state(kb.name);
  let newKbSlug = $state(slugify(kb.name));
  let selectedRemoteKbId = $state('');
  let strategy = $state<SyncStrategy>({ ...DEFAULT_SYNC_STRATEGY });
  let dryRunResult = $state<DiffResult | null>(null);
  let dryRunLoading = $state(false);
  let dryRunError = $state('');
  let userConfirmed = $state(false);
  let submitting = $state(false);

  function slugify(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // All-CJK / non-ASCII names strip to empty — fall back to a unique slug so
    // repeated bind attempts don't collide on the server-side auto-slug.
    if (!base) {
      const ts = Math.floor(Date.now() / 1000).toString(36);
      return `kb-${ts}`;
    }
    return base;
  }

  const unsubSettings = settingsStore.subscribe(state => {
    picoraTargets = state.imageHostTargets.filter(t => t.provider === 'picora');
    if (!selectedTargetId && picoraTargets.length > 0) {
      selectedTargetId = picoraTargets[0].id;
    }
  });
  onDestroy(() => { unsubSettings(); });

  async function loadRemoteKbs() {
    const target = picoraTargets.find(t => t.id === selectedTargetId);
    if (!target) return;
    loadingKbs = true;
    kbsError = '';
    try {
      const base = picoraApiBase(target.picoraApiUrl);
      const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
      const apiKey = await getPicoraApiKey(target);
      // Hide the legacy client-invented "AI Memory" KB (see
      // src/lib/services/memory/cloud-sync.ts) — an internal memory-sync
      // target, not a KB the user would want to bind a local folder to.
      remoteKbs = (await listKbs(base, apiKey)).filter(kb => kb.slug !== 'memory');
    } catch (e) {
      kbsError = typeof e === 'string' ? e : 'Failed to load Knowledge Bases';
    } finally {
      loadingKbs = false;
    }
  }

  async function goToStep2() {
    await loadRemoteKbs();
    // Stay on step 1 if the KB list failed — surface the error inline so the
    // user can fix credentials / endpoint before advancing. Empty list is OK
    // (user creates a new KB on step 2).
    if (kbsError) return;
    step = 2;
  }

  async function goToStep4() {
    dryRunLoading = true;
    dryRunError = '';
    dryRunResult = null;
    try {
      const target = picoraTargets.find(t => t.id === selectedTargetId)!;
      const picoraKbId = createMode ? '__preview__' : selectedRemoteKbId;
      const tempBinding: KbBinding = {
        localKbId: kb.id,
        picoraTargetId: selectedTargetId,
        picoraKbId,
        picoraKbName: createMode ? newKbName : (remoteKbs.find(k => k.id === selectedRemoteKbId)?.name ?? ''),
        strategy,
        lastSyncAt: null,
        lastSyncReport: null,
        lastSyncError: null,
      };
      if (!createMode) {
        const result = await dryRunSync(tempBinding, kb, target);
        dryRunResult = result.diff ?? null;
      }
      step = 4;
    } catch (e) {
      dryRunError = typeof e === 'string' ? e : 'Failed to preview sync';
    } finally {
      dryRunLoading = false;
    }
  }

  /** True iff the most recent create-kb error is a duplicate name/slug. */
  let conflictRecoverable = $state(false);

  async function confirmBind() {
    if (!userConfirmed) return;
    submitting = true;
    conflictRecoverable = false;
    try {
      const target = picoraTargets.find(t => t.id === selectedTargetId)!;
      const base = picoraApiBase(target.picoraApiUrl);
      const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
      const apiKey = await getPicoraApiKey(target);

      let picoraKbId: string;
      let picoraKbName: string;
      if (createMode) {
        const created = await createKb(base, apiKey, newKbName, newKbSlug || undefined);
        picoraKbId = created.id;
        picoraKbName = created.name;
      } else {
        const selected = remoteKbs.find(k => k.id === selectedRemoteKbId)!;
        picoraKbId = selected.id;
        picoraKbName = selected.name;
      }

      const binding: KbBinding = {
        localKbId: kb.id,
        picoraTargetId: selectedTargetId,
        picoraKbId,
        picoraKbName,
        strategy,
        lastSyncAt: null,
        lastSyncReport: null,
        lastSyncError: null,
      };

      filesStore.setKbBinding(kb.id, binding);
      onBound(binding);
      onClose();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Binding failed');
      // Cloud KB count hit the plan limit (server: "KB count N/N reached …").
      // Show an actionable message instead of the raw English/JSON error, and
      // steer the user toward linking an existing cloud KB.
      if (createMode && /quota|reached|KB count|plan (limit|count)/i.test(msg)) {
        dryRunError = $t('kb_sync.error.kb_quota_reached');
        conflictRecoverable = true;
      } else {
        dryRunError = msg;
        // Detect "create-kb" + (409 already exists / 422 validation / "exists" / "duplicate" / "conflict")
        // → offer to switch to link-existing mode and refresh the remote KB list.
        if (createMode && /create-kb/i.test(msg) && /exist|duplicat|conflict|already/i.test(msg)) {
          conflictRecoverable = true;
        }
      }
    } finally {
      submitting = false;
    }
  }

  /** Recovery: switch to link-existing mode, reload the remote KB list,
   * pre-select the KB whose name matches the one the user tried to create. */
  async function switchToLinkExisting() {
    conflictRecoverable = false;
    dryRunError = '';
    createMode = false;
    await loadRemoteKbs();
    const match = remoteKbs.find(k => k.name === newKbName.trim());
    if (match) selectedRemoteKbId = match.id;
    step = 2;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  let remoteKbOptions = $derived([
    { value: '', label: $t('kb_sync.bind_dialog.select_kb') },
    ...remoteKbs.map(rKb => ({ value: rKb.id, label: `${rKb.name} · ${rKb.docCount} docs` })),
  ]);

  let modeOptions = $derived([
    { value: 'manual', label: $t('kb_sync.strategy.mode_manual') },
    { value: 'on-save', label: $t('kb_sync.strategy.mode_on_save') },
    { value: 'interval', label: $t('kb_sync.strategy.mode_interval') },
    { value: 'on-startup-and-close', label: $t('kb_sync.strategy.mode_startup') },
  ]);

  let intervalOptions = $derived([
    { value: 60, label: $t('kb_sync.strategy.interval60') },
    { value: 300, label: $t('kb_sync.strategy.interval300') },
    { value: 900, label: $t('kb_sync.strategy.interval900') },
    { value: 1800, label: $t('kb_sync.strategy.interval1800') },
  ]);

  let scopeOptions = $derived([
    { value: 'markdown-only', label: $t('kb_sync.strategy.scope_md_only') },
    { value: 'markdown-plus-rules', label: $t('kb_sync.strategy.scope_md_rules') },
    { value: 'all-including-hidden', label: $t('kb_sync.strategy.scope_all') },
  ]);

  let conflictOptions = $derived([
    { value: 'prompt', label: $t('kb_sync.strategy.conflict_prompt') },
    { value: 'prefer-local', label: $t('kb_sync.strategy.conflict_local') },
    { value: 'prefer-remote', label: $t('kb_sync.strategy.conflict_remote') },
  ]);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onkeydown={(e) => e.key === 'Escape' && onClose()} onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="bind-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="dialog-header">
      <span class="dialog-icon">
        <svg width="18" height="18" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="#2563eb" />
          <path d="M9.5 7.5v17" stroke="#ffffff" stroke-width="3" stroke-linecap="round" />
          <circle cx="16" cy="14" r="6.5" stroke="#ffffff" stroke-width="3" />
          <circle cx="16" cy="14" r="2.4" fill="#ffffff" />
        </svg>
      </span>
      <h3>{$t('kb_sync.bind_dialog.title').replace('{name}', kb.name)}</h3>
      <button class="close-btn" onclick={onClose}>&times;</button>
    </div>

    <div class="step-indicator">
      {#each [1,2,3,4] as s}
        <span class="step-dot" class:active={step >= s}></span>
      {/each}
      <span class="step-label">{$t('kb_sync.bind_dialog.step').replace('{current}', String(step)).replace('{total}', '4')}</span>
    </div>

    <div class="dialog-body">
      {#if step === 1}
        <h4>{$t('kb_sync.bind_dialog.step1_title')}</h4>
        {#if picoraTargets.length === 0}
          <p class="hint-text">{$t('kb_sync.bind_dialog.no_picora')}</p>
        {:else}
          <div class="target-list">
            {#each picoraTargets as target}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="target-item"
                class:selected={selectedTargetId === target.id}
                onclick={() => { selectedTargetId = target.id; }}
              >
                <span class="target-email">{target.picoraUserEmail || target.name}</span>
                <span class="target-url">{picoraApiBase(target.picoraApiUrl)}</span>
              </div>
            {/each}
          </div>
          {#if loadingKbs}
            <p class="hint-text">{$t('kb_sync.bind_dialog.loading_kbs')}</p>
          {:else if kbsError}
            <p class="error-text">{kbsError}</p>
          {/if}
        {/if}

      {:else if step === 2}
        <h4>{$t('kb_sync.bind_dialog.step2_title')}</h4>
        {#if loadingKbs}
          <p class="hint-text">{$t('kb_sync.bind_dialog.loading_kbs')}</p>
        {:else if kbsError}
          <p class="error-text">{kbsError}</p>
        {:else}
          <div class="radio-group">
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <label class="radio-item">
              <input type="radio" bind:group={createMode} value={false} />
              <span>{$t('kb_sync.bind_dialog.link_existing')}</span>
            </label>
            {#if !createMode}
              <div class="radio-sub">
                <Select class="select-input" block bind:value={selectedRemoteKbId} options={remoteKbOptions} />
              </div>
            {/if}
          </div>
          <div class="radio-group">
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <label class="radio-item">
              <input type="radio" bind:group={createMode} value={true} />
              <span>{$t('kb_sync.bind_dialog.create_new')}</span>
            </label>
            {#if createMode}
              <div class="radio-sub">
                <label class="field-label">{$t('kb_sync.bind_dialog.kb_name')}
                  <input class="text-input" bind:value={newKbName} oninput={() => { newKbSlug = slugify(newKbName); }} />
                </label>
                <label class="field-label">{$t('kb_sync.bind_dialog.kb_slug')}
                  <input class="text-input" bind:value={newKbSlug} />
                </label>
              </div>
            {/if}
          </div>
        {/if}

      {:else if step === 3}
        <h4>{$t('kb_sync.bind_dialog.step3_title')}</h4>
        <div class="form-section">
          <label class="form-label">{$t('kb_sync.strategy.mode')}</label>
          <Select class="select-input" block bind:value={strategy.mode} options={modeOptions} />
          {#if strategy.mode === 'interval'}
            <Select class="select-input" block bind:value={strategy.intervalSecs} options={intervalOptions} />
          {/if}
        </div>
        <div class="form-section">
          <label class="form-label">{$t('kb_sync.strategy.scope')}</label>
          <Select class="select-input" block bind:value={strategy.scope} options={scopeOptions} />
        </div>
        <div class="form-section">
          <label class="form-label">{$t('kb_sync.strategy.conflict')}</label>
          <Select class="select-input" block bind:value={strategy.conflictPolicy} options={conflictOptions} />
        </div>

      {:else if step === 4}
        <h4>{$t('kb_sync.bind_dialog.step4_title')}</h4>
        {#if dryRunLoading}
          <p class="hint-text">{$t('kb_sync.bind_dialog.previewing')}</p>
        {:else if dryRunError}
          <p class="error-text">{dryRunError}</p>
          {#if conflictRecoverable}
            <button class="btn btn-ghost recovery-btn" onclick={switchToLinkExisting}>
              {$t('kb_sync.bind_dialog.link_existing_instead')}
            </button>
          {/if}
        {:else if dryRunResult}
          <div class="dry-run-list">
            <div class="dry-run-item upload">↑ {$t('kb_sync.bind_dialog.will_upload').replace('{n}', String(dryRunResult.uploadPaths.length))}</div>
            <div class="dry-run-item download">↓ {$t('kb_sync.bind_dialog.will_download').replace('{n}', String(dryRunResult.downloadPaths.length))}</div>
            <div class="dry-run-item delete">⊘ {$t('kb_sync.bind_dialog.will_delete').replace('{n}', String(dryRunResult.deleteLocalPaths.length + dryRunResult.deleteRemotePaths.length))}</div>
            {#if dryRunResult.skippedLarge.length > 0}
              <div class="dry-run-item skip">⚠ {$t('kb_sync.bind_dialog.skipped').replace('{n}', String(dryRunResult.skippedLarge.length))}</div>
              {#each dryRunResult.skippedLarge.slice(0, 3) as s}
                <div class="dry-run-sub">{s.relativePath} ({formatBytes(s.sizeBytes)})</div>
              {/each}
            {/if}
          </div>
        {:else}
          <p class="hint-text">{$t('kb_sync.bind_dialog.first_bind_hint')}</p>
        {/if}
        <label class="confirm-check">
          <input type="checkbox" bind:checked={userConfirmed} />
          {$t('kb_sync.bind_dialog.confirm_label')}
        </label>
      {/if}
    </div>

    <div class="dialog-footer">
      {#if step > 1}
        <button class="btn btn-ghost" onclick={() => { step -= 1; }}>{$t('kb_sync.bind_dialog.back')}</button>
      {:else}
        <button class="btn btn-ghost" onclick={onClose}>{$t('common.cancel')}</button>
      {/if}

      {#if step < 3}
        <button
          class="btn btn-primary"
          disabled={
            step === 1
              ? (!selectedTargetId || loadingKbs)
              : (createMode ? !newKbName.trim() : !selectedRemoteKbId)
          }
          onclick={step === 1 ? goToStep2 : () => { step = 3; }}
        >
          {step === 1 && loadingKbs
            ? $t('kb_sync.bind_dialog.loading_kbs')
            : $t('kb_sync.bind_dialog.next')}
        </button>
      {:else if step === 3}
        <button class="btn btn-primary" onclick={goToStep4} disabled={dryRunLoading}>
          {$t('kb_sync.bind_dialog.next')}
        </button>
      {:else}
        <button
          class="btn btn-primary"
          disabled={!userConfirmed || submitting}
          onclick={confirmBind}
        >
          {submitting ? $t('kb_sync.bind_dialog.binding') : $t('kb_sync.bind_dialog.start_sync')}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }

  .bind-dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    width: 520px;
    max-height: 80vh;
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

  .dialog-icon { font-size: 1.1rem; display: inline-flex; align-items: center; }
  .dialog-icon svg { display: block; }

  .dialog-header h3 {
    margin: 0;
    flex: 1;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
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

  .step-indicator {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }

  .step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border-color);
    transition: background 0.2s;
  }

  .step-dot.active {
    background: var(--accent-color);
  }

  .step-label {
    margin-left: 0.5rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .dialog-body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
  }

  .dialog-body h4 {
    margin: 0 0 0.75rem;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .hint-text {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .error-text {
    color: var(--color-error, #e53e3e);
    font-size: var(--font-size-sm);
  }

  .recovery-btn {
    margin-top: 0.5rem;
    align-self: flex-start;
  }

  .target-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .target-item {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }

  .target-item.selected {
    border-color: var(--accent-color);
    background: color-mix(in srgb, var(--accent-color) 8%, transparent);
  }

  .target-email {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .target-url {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .radio-group {
    margin-bottom: 0.75rem;
  }

  .radio-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }

  .radio-sub {
    margin: 0.5rem 0 0 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .field-label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .text-input {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    width: 100%;
  }

  .text-input:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .form-section {
    margin-bottom: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .form-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-weight: 600;
  }

  .dry-run-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 1rem;
  }

  .dry-run-item {
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    font-size: var(--font-size-sm);
  }

  .dry-run-item.upload { background: color-mix(in srgb, #3b82f6 10%, transparent); color: #3b82f6; }
  .dry-run-item.download { background: color-mix(in srgb, #10b981 10%, transparent); color: #10b981; }
  .dry-run-item.delete { background: color-mix(in srgb, #ef4444 10%, transparent); color: #ef4444; }
  .dry-run-item.skip { background: color-mix(in srgb, #f59e0b 10%, transparent); color: #f59e0b; }

  .dry-run-sub {
    padding: 0.1rem 0.6rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .confirm-check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
    margin-top: 0.5rem;
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .btn {
    padding: 0.4rem 1rem;
    border-radius: 5px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    border: 1px solid transparent;
    transition: opacity 0.15s;
  }

  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-ghost {
    background: transparent;
    border-color: var(--border-color);
    color: var(--text-secondary);
  }

  .btn-primary {
    background: var(--accent-color);
    color: white;
  }

  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
</style>
