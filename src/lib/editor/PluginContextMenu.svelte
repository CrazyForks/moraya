<script lang="ts">
  import { t } from '$lib/i18n';
  import type { InstalledPlugin } from '$lib/services/plugin/types';

  let {
    position,
    plugins,
    invokingId,
    onInvoke,
    onClose,
  }: {
    position: { top: number; left: number };
    plugins: InstalledPlugin[];
    invokingId: string | null;
    onInvoke: (pluginId: string) => void;
    onClose: () => void;
  } = $props();

  const tr = $t;
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu-backdrop" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
  <div
    class="context-menu"
    style="top: {position.top}px; left: {position.left}px"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="menu-header">{tr('plugin_action.title')}</div>
    {#each plugins as plugin}
      <button
        class="menu-item"
        class:invoking={invokingId === plugin.manifest.id}
        disabled={invokingId !== null}
        onclick={() => onInvoke(plugin.manifest.id)}
      >
        <span class="plugin-name">{plugin.manifest.name}</span>
        {#if invokingId === plugin.manifest.id}
          <span class="status-badge invoking">{tr('plugin_action.invoking')}</span>
        {:else}
          <span class="plugin-action">{tr('plugin_action.run_action')}</span>
        {/if}
      </button>
    {/each}
    {#if plugins.length === 0}
      <div class="menu-empty">{tr('plugin_action.no_plugins')}</div>
    {/if}
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
    min-width: 200px;
    padding: 0.25rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 61;
  }

  .menu-header {
    padding: 0.3rem 0.75rem 0.2rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.4rem 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border-radius: 4px;
    text-align: left;
    gap: 0.5rem;
  }

  .menu-item:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .menu-item:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .plugin-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .plugin-action {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .status-badge {
    font-size: var(--font-size-xs);
    white-space: nowrap;
  }

  .status-badge.invoking {
    color: var(--accent-color, #0066cc);
  }

  .menu-empty {
    padding: 0.5rem 0.75rem;
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    text-align: center;
  }
</style>
