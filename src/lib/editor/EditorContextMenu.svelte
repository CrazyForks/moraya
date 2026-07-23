<script lang="ts">
  import { t } from '$lib/i18n';
  import { isMacOS } from '$lib/utils/platform';

  let {
    position,
    hasImages = false,
    hasSelection = false,
    inSpecialBlock = false,
    showCloudInsert = true,
    onCut,
    onCopy,
    onPaste,
    onUploadAllImages,
    onSEO,
    onImageGen,
    onPublish,
    onAddReview,
    onInsertCloudImage,
    onInsertCloudAudio,
    onInsertCloudVideo,
    onClose,
  }: {
    position: { top: number; left: number };
    hasImages?: boolean;
    hasSelection?: boolean;
    inSpecialBlock?: boolean;
    showCloudInsert?: boolean;
    onCut: () => void;
    onCopy: () => void;
    onPaste: () => void;
    onUploadAllImages?: () => void;
    onSEO: () => void;
    onImageGen: () => void;
    onPublish: () => void;
    onAddReview?: () => void;
    onInsertCloudImage?: () => void;
    onInsertCloudAudio?: () => void;
    onInsertCloudVideo?: () => void;
    onClose: () => void;
  } = $props();

  const modKey = isMacOS ? '⌘' : 'Ctrl+';

  // Auto-flip: measure menu after render and flip if it would overflow viewport
  let menuEl: HTMLDivElement | undefined = $state();
  let adjustedTop = $state(position.top);
  let adjustedLeft = $state(position.left);

  $effect(() => {
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const viewH = window.innerHeight;
    const viewW = window.innerWidth;
    adjustedTop = (position.top + rect.height > viewH)
      ? Math.max(4, position.top - rect.height)
      : position.top;
    adjustedLeft = (position.left + rect.width > viewW)
      ? Math.max(4, viewW - rect.width - 4)
      : position.left;
  });

  function handleAction(action: () => void) {
    action();
    onClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
{#snippet picoraIcon()}
  <svg class="picora-icon" width="15" height="15" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="#2563eb" />
    <path d="M9.5 7.5v17" stroke="#ffffff" stroke-width="3" stroke-linecap="round" />
    <circle cx="16" cy="14" r="6.5" stroke="#ffffff" stroke-width="3" />
    <circle cx="16" cy="14" r="2.4" fill="#ffffff" />
  </svg>
{/snippet}

<div class="menu-backdrop" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
  <div
    bind:this={menuEl}
    class="context-menu"
    style="top: {adjustedTop}px; left: {adjustedLeft}px"
    onclick={(e) => e.stopPropagation()}
  >
    <button class="menu-item" onclick={() => handleAction(onCut)}>
      <span>{$t('context_menu.cut')}</span>
      <span class="shortcut">{modKey}X</span>
    </button>

    <button class="menu-item" onclick={() => handleAction(onCopy)}>
      <span>{$t('context_menu.copy')}</span>
      <span class="shortcut">{modKey}C</span>
    </button>

    <button class="menu-item" onclick={() => handleAction(onPaste)}>
      <span>{$t('context_menu.paste')}</span>
      <span class="shortcut">{modKey}V</span>
    </button>

    {#if onAddReview}
      <div class="menu-divider"></div>
      <button
        class="menu-item"
        disabled={!hasSelection}
        onclick={() => { if (onAddReview) handleAction(onAddReview); }}
      >
        <span>{$t('review.add_review')}</span>
        <span class="shortcut">⌘⇧R</span>
      </button>
    {/if}

    {#if showCloudInsert && !inSpecialBlock && (onInsertCloudImage || onInsertCloudAudio || onInsertCloudVideo)}
      <div class="menu-divider"></div>
      {#if onInsertCloudImage}
        <button class="menu-item" onclick={() => { if (onInsertCloudImage) handleAction(onInsertCloudImage); }}>
          <span class="cloud-label">{@render picoraIcon()}{$t('context_menu.insert_cloud_image')}</span>
        </button>
      {/if}
      {#if onInsertCloudAudio}
        <button class="menu-item" onclick={() => { if (onInsertCloudAudio) handleAction(onInsertCloudAudio); }}>
          <span class="cloud-label">{@render picoraIcon()}{$t('context_menu.insert_cloud_audio')}</span>
        </button>
      {/if}
      {#if onInsertCloudVideo}
        <button class="menu-item" onclick={() => { if (onInsertCloudVideo) handleAction(onInsertCloudVideo); }}>
          <span class="cloud-label">{@render picoraIcon()}{$t('context_menu.insert_cloud_video')}</span>
        </button>
      {/if}
    {/if}

    <div class="menu-divider"></div>

    <button class="menu-item" disabled={!hasImages} onclick={() => { if (onUploadAllImages) handleAction(onUploadAllImages); }}>
      {$t('context_menu.upload_all_images')}
    </button>

    <div class="menu-divider"></div>

    <button class="menu-item" onclick={() => handleAction(onSEO)}>
      {$t('menu.seo_optimization')}
    </button>

    <button class="menu-item" onclick={() => handleAction(onImageGen)}>
      {$t('menu.ai_image_generation')}
    </button>

    <button class="menu-item" onclick={() => handleAction(onPublish)}>
      {$t('menu.publish')}
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
    min-width: 200px;
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
  }

  .cloud-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .picora-icon {
    flex: none;
    display: block;
    border-radius: 4px;
  }

  .menu-item:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .menu-item:disabled {
    color: var(--text-muted);
    cursor: default;
    opacity: 0.5;
  }

  .shortcut {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-left: 1.5rem;
    flex-shrink: 0;
  }

  .menu-divider {
    height: 1px;
    background: var(--border-light);
    margin: 0.25rem 0.5rem;
  }
</style>
