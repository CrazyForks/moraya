<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { t } from '$lib/i18n';
  import { Select, type SelectOption } from '$lib/components/ui';
  import { filesStore, type KnowledgeBase } from '$lib/stores/files-store';
  import { settingsStore } from '$lib/stores/settings-store';
  import {
    scanClaudePrompts,
    importCandidates,
    setClaudeDir,
    getKbState,
    type ScanResult,
    type PromptCandidate,
  } from '$lib/services/prompt-asset';

  // ── Knowledge bases ──────────────────────────────────────────────────────
  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let selectedKbId = $state<string | null>(null);
  const unsubFiles = filesStore.subscribe((s) => {
    knowledgeBases = s.knowledgeBases;
    if (selectedKbId === null && s.activeKnowledgeBaseId) selectedKbId = s.activeKnowledgeBaseId;
    if (selectedKbId === null && s.knowledgeBases.length > 0) selectedKbId = s.knowledgeBases[0].id;
  });
  onDestroy(() => unsubFiles());

  let kbOptions = $derived<SelectOption[]>(
    knowledgeBases.map((kb) => ({ value: kb.id, label: kb.name })),
  );
  let selectedKb = $derived(knowledgeBases.find((kb) => kb.id === selectedKbId) ?? null);

  // ── Scan / preview state ─────────────────────────────────────────────────
  let claudeDir = $state('');
  let scanning = $state(false);
  let importing = $state(false);
  let scan = $state<ScanResult | null>(null);
  /** Selected candidate keys (drives which prompts get written). */
  let selected = $state<Set<string>>(new Set());
  let statusKey = $state<string | null>(null);
  let statusParams = $state<Record<string, string>>({});

  onMount(async () => {
    if (selectedKbId) {
      const st = await getKbState(selectedKbId);
      claudeDir = st.claudeDir ?? '';
    }
  });

  async function handleScan() {
    if (!selectedKbId || scanning) return;
    scanning = true;
    statusKey = null;
    scan = null;
    try {
      const dir = claudeDir.trim() || null;
      await setClaudeDir(selectedKbId, dir);
      const result = await scanClaudePrompts(selectedKbId, { claudeDir: dir, incremental: false });
      scan = result;
      // Default selection: everything that looks like a real requirement prompt.
      const next = new Set<string>();
      for (const g of result.groups) for (const c of g.candidates) if (c.likely) next.add(c.key);
      selected = next;
      if (result.totalCandidates === 0) statusKey = 'prompt_asset.scan_empty';
    } catch (e) {
      statusKey = 'prompt_asset.scan_error';
      statusParams = { error: String(e).slice(0, 120) };
    } finally {
      scanning = false;
    }
  }

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
  }

  function toggleGroup(candidates: PromptCandidate[], on: boolean) {
    const next = new Set(selected);
    for (const c of candidates) {
      if (on) next.add(c.key);
      else next.delete(c.key);
    }
    selected = next;
  }

  function groupAllSelected(candidates: PromptCandidate[]): boolean {
    return candidates.length > 0 && candidates.every((c) => selected.has(c.key));
  }

  async function handleImport() {
    if (!selectedKb || !scan || importing) return;
    const chosen: PromptCandidate[] = [];
    for (const g of scan.groups) for (const c of g.candidates) if (selected.has(c.key)) chosen.push(c);
    if (chosen.length === 0) return;

    importing = true;
    statusKey = null;
    try {
      const result = await importCandidates(selectedKb.id, selectedKb.path, chosen, scan.scanMtime);
      statusKey = 'prompt_asset.import_done';
      statusParams = { count: String(result.written) };
      // Refresh the file tree so the new prompts/ files show up immediately.
      if (get(filesStore).activeKnowledgeBaseId === selectedKb.id) {
        void filesStore.setActiveKnowledgeBase(selectedKb.id);
      }
      // Best-effort cloud sync if this KB is Picora-bound.
      void maybeSync(selectedKb);
      // Clear the imported candidates from the preview.
      scan = null;
      selected = new Set();
    } catch (e) {
      statusKey = 'prompt_asset.import_error';
      statusParams = { error: String(e).slice(0, 120) };
    } finally {
      importing = false;
    }
  }

  async function maybeSync(kb: KnowledgeBase) {
    const binding = kb.picoraBinding;
    if (!binding) return;
    const target = (get(settingsStore).imageHostTargets ?? []).find(
      (tg) => tg.id === binding.picoraTargetId,
    );
    if (!target) return;
    try {
      const { runSync } = await import('$lib/services/kb-sync/sync-service');
      await runSync(binding, kb, target, false);
    } catch {
      // Sync failures are non-fatal; files are already saved locally.
    }
  }

  function shortSession(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  function preview(text: string): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine;
  }

  let selectedCount = $derived(selected.size);
</script>

<div class="prompt-asset-settings gx-tab">
  <section class="settings-section">
    <div class="section-header">
      <h3 class="section-title">{$t('prompt_asset.title')}</h3>
      <p class="section-subtitle">{$t('prompt_asset.desc')}</p>
    </div>

    <div class="card">
      {#if knowledgeBases.length === 0}
        <p class="empty-hint">{$t('prompt_asset.no_kb')}</p>
      {:else}
        <div class="row">
          <span class="row-label">{$t('prompt_asset.target_kb')}</span>
          <Select
            value={selectedKbId}
            options={kbOptions}
            onchange={(v) => (selectedKbId = v as string)}
            ariaLabel={$t('prompt_asset.target_kb')}
          />
        </div>
        <div class="row">
          <span class="row-label">{$t('prompt_asset.claude_dir')}</span>
          <input
            type="text"
            class="dir-input"
            bind:value={claudeDir}
            placeholder="~/.claude"
            spellcheck="false"
          />
        </div>
        <p class="privacy-note">{$t('prompt_asset.privacy_note')}</p>
        <div class="actions">
          <button class="primary-btn" onclick={handleScan} disabled={scanning || !selectedKbId}>
            {scanning ? $t('prompt_asset.scanning') : $t('prompt_asset.scan_btn')}
          </button>
        </div>
      {/if}
    </div>
  </section>

  {#if scan && scan.groups.length > 0}
    <section class="settings-section">
      <div class="section-header list-header">
        <h3 class="section-title">{$t('prompt_asset.preview_title')}</h3>
        <span class="count-pill">{$t('prompt_asset.selected_count', { n: String(selectedCount) })}</span>
      </div>

      <div class="groups">
        {#each scan.groups as g (g.sessionId)}
          <div class="group">
            <label class="group-header">
              <input
                type="checkbox"
                checked={groupAllSelected(g.candidates)}
                onchange={(e) => toggleGroup(g.candidates, (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="group-project">{g.project}</span>
              <span class="group-session">#{shortSession(g.sessionId)}</span>
              <span class="group-count">{g.candidates.length}</span>
            </label>
            {#each g.candidates as c (c.key)}
              <label class="cand-row" class:unlikely={!c.likely}>
                <input type="checkbox" checked={selected.has(c.key)} onchange={() => toggle(c.key)} />
                <span class="cand-text">{preview(c.text)}</span>
                <span class="cand-time">{c.sentAt.slice(0, 10)}</span>
              </label>
            {/each}
          </div>
        {/each}
      </div>

      <div class="actions">
        <button class="primary-btn" onclick={handleImport} disabled={importing || selectedCount === 0}>
          {importing
            ? $t('prompt_asset.importing')
            : $t('prompt_asset.import_btn', { n: String(selectedCount) })}
        </button>
      </div>
    </section>
  {/if}

  {#if statusKey}
    <p class="status">{$t(statusKey, statusParams)}</p>
  {/if}
</div>

<style>
  .prompt-asset-settings {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .section-header { display: flex; flex-direction: column; gap: 2px; }
  .list-header { flex-direction: row; align-items: center; gap: 8px; }
  .section-title { font-size: var(--font-size-base); font-weight: 600; margin: 0; color: var(--text-primary); }
  .section-subtitle { font-size: var(--font-size-sm); color: var(--text-secondary); margin: 0; }
  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .row-label { font-size: var(--font-size-sm); color: var(--text-primary); white-space: nowrap; }
  .dir-input, .cand-text {
    font-size: var(--font-size-sm);
  }
  .dir-input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-mono, monospace);
  }
  .privacy-note {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.5;
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .primary-btn {
    padding: 7px 16px;
    border: none;
    border-radius: 6px;
    background: var(--accent-color, #4a7cff);
    color: #fff;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .empty-hint { font-size: var(--font-size-sm); color: var(--text-secondary); margin: 0; }
  .count-pill {
    font-size: var(--font-size-xs);
    background: var(--bg-tertiary, var(--bg-secondary));
    color: var(--text-secondary);
    padding: 2px 8px;
    border-radius: 10px;
  }
  .groups { display: flex; flex-direction: column; gap: 10px; }
  .group {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
  }
  .group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--bg-secondary);
    cursor: pointer;
    font-size: var(--font-size-sm);
  }
  .group-project { font-weight: 600; color: var(--text-primary); }
  .group-session { color: var(--text-secondary); font-family: var(--font-mono, monospace); font-size: var(--font-size-xs); }
  .group-count {
    margin-left: auto;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }
  .cand-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-top: 1px solid var(--border-color);
    cursor: pointer;
  }
  .cand-row.unlikely { opacity: 0.7; }
  .cand-text {
    flex: 1;
    min-width: 0;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cand-time { font-size: var(--font-size-xs); color: var(--text-secondary); white-space: nowrap; }
  .status { font-size: var(--font-size-sm); color: var(--text-secondary); margin: 0; }
</style>
