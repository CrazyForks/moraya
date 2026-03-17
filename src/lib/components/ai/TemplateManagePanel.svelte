<script lang="ts">
  import { t } from '$lib/i18n';
  import {
    getAllTemplates,
    getTemplateName,
    getTemplateDesc,
    deleteTemplate,
    exportTemplates,
    type AITemplate,
  } from '$lib/services/ai';

  let {
    onBack,
  }: {
    onBack: () => void;
  } = $props();

  let templates = $state<AITemplate[]>([]);
  let confirmDeleteId = $state<string | null>(null);

  // Load custom templates only
  function refresh() {
    templates = getAllTemplates().filter(t => t.source === 'global' || t.source === 'kb');
  }

  refresh();

  async function handleDelete(tpl: AITemplate) {
    if (confirmDeleteId !== tpl.id) {
      confirmDeleteId = tpl.id;
      return;
    }
    confirmDeleteId = null;
    const scope = tpl.source === 'kb' ? 'kb' : 'global';
    try {
      await deleteTemplate(tpl.id, scope as 'global' | 'kb');
      refresh();
    } catch (e) {
      console.error('Delete failed:', e);
    }
  }

  async function handleExportSingle(tpl: AITemplate) {
    try {
      await exportTemplates([tpl]);
    } catch (e) {
      console.error('Export failed:', e);
    }
  }
</script>

<div class="manage-panel">
  <div class="manage-header">
    <button class="back-btn" onclick={onBack}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
        <path d="M9.5 1L3.5 7l6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
      </svg>
      <span>{$t('templates.gallery.back')}</span>
    </button>
    <span class="manage-title">{$t('templates.manage.title')}</span>
  </div>

  <div class="manage-content">
    {#if templates.length === 0}
      <div class="empty-state">{$t('templates.manage.noCustomTemplates')}</div>
    {:else}
      {#each templates as tpl (tpl.id)}
        <div class="manage-item">
          <span class="item-icon">{tpl.icon}</span>
          <div class="item-info">
            <span class="item-name">{getTemplateName(tpl, $t)}</span>
            <span class="item-desc">{getTemplateDesc(tpl, $t)}</span>
            <div class="item-meta">
              <span class="source-badge {tpl.source}">{tpl.source === 'kb' ? $t('templates.manage.sourceKb') : $t('templates.manage.sourceGlobal')}</span>
              <span class="item-category">{tpl.category}</span>
            </div>
          </div>
          <div class="item-actions">
            <button class="action-btn" onclick={() => handleExportSingle(tpl)} title={$t('templates.manage.export')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 8V1m-3 3l3-3 3 3M1 10h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            </button>
            <button
              class="action-btn delete"
              class:confirming={confirmDeleteId === tpl.id}
              onclick={() => handleDelete(tpl)}
              title={confirmDeleteId === tpl.id ? $t('templates.manage.deleteConfirm') : $t('templates.manage.delete')}
            >
              {#if confirmDeleteId === tpl.id}
                <span class="confirm-text">{$t('templates.manage.deleteConfirm')}</span>
              {:else}
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 1V0h6v1h3v1.5H0V1h3zm.5 3h1v6h-1V4zm4 0h1v6h-1V4zM1 2.5h10l-.75 9.5H1.75L1 2.5z" fill="currentColor"/></svg>
              {/if}
            </button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .manage-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .manage-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0.75rem 0.25rem;
    min-height: 1.75rem;
  }

  .back-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    border: none;
    background: none;
    color: var(--accent-color);
    cursor: pointer;
    font-size: var(--font-size-xs);
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
  }

  .back-btn:hover {
    background: var(--bg-hover);
  }

  .manage-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .manage-content {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0.75rem 0.75rem;
  }

  .empty-state {
    text-align: center;
    padding: 2rem 1rem;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
  }

  .manage-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem;
    border-radius: 6px;
    border: 1px solid transparent;
    transition: background var(--transition-fast);
  }

  .manage-item:hover {
    background: var(--bg-hover);
    border-color: var(--border-color);
  }

  .item-icon {
    font-size: 1.1rem;
    flex-shrink: 0;
    width: 1.5rem;
    text-align: center;
    margin-top: 0.1rem;
  }

  .item-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .item-name {
    font-size: var(--font-size-xs);
    font-weight: 500;
    color: var(--text-primary);
  }

  .item-desc {
    font-size: 10px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.1rem;
  }

  .source-badge {
    font-size: 9px;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    background: var(--bg-hover);
    color: var(--accent-color);
  }

  .source-badge.kb {
    color: var(--success-color, #4caf50);
  }

  .item-category {
    font-size: 9px;
    color: var(--text-muted);
  }

  .item-actions {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 3px;
  }

  .action-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .action-btn.delete:hover {
    color: var(--error-color, #e53935);
  }

  .action-btn.confirming {
    width: auto;
    padding: 0 0.4rem;
    background: var(--error-color, #e53935);
    color: white;
  }

  .confirm-text {
    font-size: 9px;
    white-space: nowrap;
  }
</style>
