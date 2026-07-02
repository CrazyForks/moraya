<script lang="ts">
  import { t } from '$lib/i18n';

  let {
    position,
    onAddRowBefore,
    onAddRowAfter,
    onAddColBefore,
    onAddColAfter,
    onDeleteRow,
    onDeleteCol,
    onCopyTable,
    onFormatTableSource,
    onDeleteTable,
    onClose,
  }: {
    position: { top: number; left: number };
    onAddRowBefore: () => void;
    onAddRowAfter: () => void;
    onAddColBefore: () => void;
    onAddColAfter: () => void;
    onDeleteRow: () => void;
    onDeleteCol: () => void;
    onCopyTable: () => void;
    onFormatTableSource: () => void;
    onDeleteTable: () => void;
    onClose: () => void;
  } = $props();

  const tr = $t;

  function handleAction(action: () => void) {
    action();
    onClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu-backdrop" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
  <div
    class="context-menu"
    style="top: {position.top}px; left: {position.left}px"
    onclick={(e) => e.stopPropagation()}
  >
    <button class="menu-item" onclick={() => handleAction(onAddRowBefore)}>
      <span class="menu-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="12" y1="3" x2="12" y2="12"/>
          <line x1="9" y1="7" x2="15" y2="7"/>
        </svg>
      </span>
      <span class="menu-label">{tr('table.insert_row_above')}</span>
    </button>

    <button class="menu-item" onclick={() => handleAction(onAddRowAfter)}>
      <span class="menu-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="12" y1="12" x2="12" y2="21"/>
          <line x1="9" y1="17" x2="15" y2="17"/>
        </svg>
      </span>
      <span class="menu-label">{tr('table.insert_row_below')}</span>
      <span class="shortcut">⌘↩</span>
    </button>

    <div class="menu-divider"></div>

    <button class="menu-item" onclick={() => handleAction(onAddColBefore)}>
      <span class="menu-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="12" y1="3" x2="12" y2="21"/>
          <line x1="3" y1="12" x2="12" y2="12"/>
          <line x1="7" y1="9" x2="7" y2="15"/>
        </svg>
      </span>
      <span class="menu-label">{tr('table.insert_col_left')}</span>
    </button>

    <button class="menu-item" onclick={() => handleAction(onAddColAfter)}>
      <span class="menu-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="12" y1="3" x2="12" y2="21"/>
          <line x1="12" y1="12" x2="21" y2="12"/>
          <line x1="17" y1="9" x2="17" y2="15"/>
        </svg>
      </span>
      <span class="menu-label">{tr('table.insert_col_right')}</span>
    </button>

    <div class="menu-divider"></div>

    <button class="menu-item danger" onclick={() => handleAction(onDeleteRow)}>
      <span class="menu-icon danger">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="9" y1="5.5" x2="15" y2="10.5"/>
          <line x1="15" y1="5.5" x2="9" y2="10.5"/>
        </svg>
      </span>
      <span class="menu-label">{tr('table.delete_row')}</span>
      <span class="shortcut danger">⇧⌘⌫</span>
    </button>

    <button class="menu-item danger" onclick={() => handleAction(onDeleteCol)}>
      <span class="menu-icon danger">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="12" y1="3" x2="12" y2="21"/>
          <line x1="5.5" y1="9" x2="10.5" y2="15"/>
          <line x1="10.5" y1="9" x2="5.5" y2="15"/>
        </svg>
      </span>
      <span class="menu-label">{tr('table.delete_col')}</span>
    </button>

    <div class="menu-divider"></div>

    <button class="menu-item" onclick={() => handleAction(onCopyTable)}>
      <span class="menu-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </span>
      <span class="menu-label">{tr('table.copy_table')}</span>
    </button>

    <button class="menu-item" onclick={() => handleAction(onFormatTableSource)}>
      <span class="menu-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 18 22 12 16 6"/>
          <polyline points="8 6 2 12 8 18"/>
        </svg>
      </span>
      <span class="menu-label">{tr('table.format_table_source')}</span>
    </button>

    <div class="menu-divider"></div>

    <button class="menu-item danger" onclick={() => handleAction(onDeleteTable)}>
      <span class="menu-icon danger">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/>
          <line x1="9" y1="3" x2="9" y2="9"/>
          <line x1="15" y1="3" x2="15" y2="9"/>
          <line x1="8" y1="13" x2="16" y2="21"/>
          <line x1="16" y1="13" x2="8" y2="21"/>
        </svg>
      </span>
      <span class="menu-label">{tr('table.delete_table')}</span>
    </button>
  </div>
</div>

<style>
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
  }

  .context-menu {
    position: fixed;
    min-width: 210px;
    padding: 0.25rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 61;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border-radius: 4px;
    text-align: left;
  }

  .menu-item:hover {
    background: var(--bg-hover);
  }

  .menu-item.danger:hover {
    background: rgba(232, 17, 35, 0.1);
    color: #e81123;
  }

  .menu-item.danger:hover .menu-icon.danger,
  .menu-item.danger:hover .shortcut.danger {
    color: #e81123;
  }

  .menu-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-secondary);
  }

  .menu-icon.danger {
    color: rgba(232, 17, 35, 0.55);
  }

  .menu-label {
    flex: 1;
  }

  .shortcut {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    white-space: nowrap;
    margin-left: auto;
  }

  .shortcut.danger {
    color: var(--text-muted);
  }

  .menu-divider {
    height: 1px;
    background: var(--border-light);
    margin: 0.25rem 0.5rem;
  }
</style>
