<script lang="ts">
  /**
   * Overlay wrapper around KbMemoryAssetPanel, used from the Sidebar KB dropdown
   * so a KB's memory-directory assets can be managed without opening Settings.
   * Settings embeds the same <KbMemoryAssetPanel> inline instead.
   */
  import { t } from '$lib/i18n';
  import type { KnowledgeBase } from '$lib/stores/files-store';
  import KbMemoryAssetPanel from './KbMemoryAssetPanel.svelte';

  let { kb, onClose }: { kb: KnowledgeBase; onClose: () => void } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ma-overlay" onkeydown={(e) => e.key === 'Escape' && onClose()} onclick={onClose}>
  <div class="ma-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="ma-dialog-header">
      <h3>{$t('kb_sync.settings.memory_asset')} · {kb.name}</h3>
      <button class="ma-dialog-close" onclick={onClose} aria-label="Close">&times;</button>
    </div>
    <div class="ma-dialog-body">
      <KbMemoryAssetPanel {kb} />
    </div>
  </div>
</div>

<style>
  .ma-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .ma-dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    width: 480px;
    max-width: calc(100vw - 2rem);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }
  .ma-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }
  .ma-dialog-header h3 {
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ma-dialog-close {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 1.4rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .ma-dialog-close:hover { color: var(--text-primary); }
  .ma-dialog-body { overflow-y: auto; }
</style>
