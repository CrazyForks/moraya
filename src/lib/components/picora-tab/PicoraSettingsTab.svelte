<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { ImageHostTarget } from '$lib/services/image-hosting';
  import PicoraAccountSection from './PicoraAccountSection.svelte';
  import PicoraKbSyncSection from './PicoraKbSyncSection.svelte';
  import PicoraDocVersioningSection from './PicoraDocVersioningSection.svelte';
  import PicoraResourceBrowseSection from './PicoraResourceBrowseSection.svelte';
  import PicoraAdvancedSection from './PicoraAdvancedSection.svelte';

  let { onJumpToKbSync }: { onJumpToKbSync: () => void } = $props();

  const tr = $t;

  let picoraTargets = $state<ImageHostTarget[]>([]);
  let bannerSeen = $state(true);

  const unsub = settingsStore.subscribe(s => {
    picoraTargets = (s.imageHostTargets || []).filter(t => t.provider === 'picora');
    bannerSeen = s.picoraTabSeen;
  });
  onDestroy(() => { unsub(); });

  function dismissBanner() {
    settingsStore.update({ picoraTabSeen: true });
  }

  function openImport() {
    window.dispatchEvent(new CustomEvent('moraya:picora-open-manual'));
  }

  function openRegister() {
    window.open('https://center.picora.me', '_blank', 'noreferrer');
  }
</script>

<div class="picora-tab">
  {#if !bannerSeen && picoraTargets.length > 0}
    <div class="banner">
      <span class="banner-icon">✨</span>
      <p class="banner-text">{tr('settings.picora.banner')}</p>
      <button class="banner-dismiss" onclick={dismissBanner}>{tr('settings.picora.banner_dismiss')}</button>
      <button class="banner-close" onclick={dismissBanner} aria-label={tr('common.close')}>✕</button>
    </div>
  {/if}

  {#if picoraTargets.length === 0}
    <!-- First-time welcome -->
    <div class="welcome">
      <div class="welcome-icon">
        <svg width="48" height="48" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="#2563eb" />
          <path d="M9.5 7.5v17" stroke="#ffffff" stroke-width="3" stroke-linecap="round" />
          <circle cx="16" cy="14" r="6.5" stroke="#ffffff" stroke-width="3" />
          <circle cx="16" cy="14" r="2.4" fill="#ffffff" />
        </svg>
      </div>
      <h3>{tr('settings.picora.welcome.title')}</h3>
      <p>{tr('settings.picora.welcome.body')}</p>
      <div class="welcome-actions">
        <button class="btn-primary" onclick={openImport}>✨ {tr('settings.picora.welcome.one_click')}</button>
        <button class="btn-secondary" onclick={openImport}>{tr('settings.picora.welcome.manual')}</button>
      </div>
      <div class="welcome-divider"><span>{tr('settings.picora.welcome.or')}</span></div>
      <button class="btn-link" onclick={openRegister}>{tr('settings.picora.welcome.register')} ↗</button>
    </div>
  {:else}
    <PicoraAccountSection onOpenImport={openImport} {onJumpToKbSync} />
    <hr class="divider" />
    <PicoraKbSyncSection onOpenKbSync={onJumpToKbSync} />
    <hr class="divider" />
    <PicoraDocVersioningSection />
    <hr class="divider" />
    <PicoraResourceBrowseSection />
    <hr class="divider" />
    <PicoraAdvancedSection />
  {/if}
</div>

<style>
  .picora-tab { display: flex; flex-direction: column; gap: 1rem; }

  .banner {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, var(--accent-color) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent-color) 30%, transparent);
    border-radius: 6px;
  }
  .banner-icon { font-size: 1.1rem; }
  .banner-text { margin: 0; flex: 1; font-size: var(--font-size-sm); color: var(--text-secondary); }
  .banner-dismiss {
    padding: 0.2rem 0.6rem;
    background: var(--accent-color);
    color: #fff;
    border: none; border-radius: 4px;
    cursor: pointer; font-size: var(--font-size-xs);
  }
  .banner-close {
    background: transparent; border: none;
    color: var(--text-muted); cursor: pointer; padding: 0.2rem;
  }

  .welcome {
    display: flex; flex-direction: column; align-items: center; gap: 0.6rem;
    padding: 2rem 1.5rem; text-align: center;
  }
  .welcome-icon { font-size: 3rem; }
  .welcome-icon svg { display: block; margin: 0 auto; }
  .welcome h3 { margin: 0; font-size: var(--font-size-lg); color: var(--text-primary); }
  .welcome p { margin: 0; font-size: var(--font-size-sm); color: var(--text-secondary); max-width: 460px; line-height: 1.5; }
  .welcome-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .welcome-divider {
    width: 100%; max-width: 280px; margin: 0.5rem 0;
    text-align: center; color: var(--text-muted); font-size: var(--font-size-xs);
    position: relative;
  }
  .welcome-divider::before, .welcome-divider::after {
    content: ''; position: absolute; top: 50%;
    width: calc(50% - 1.5rem); height: 1px; background: var(--border-light);
  }
  .welcome-divider::before { left: 0; }
  .welcome-divider::after { right: 0; }
  .welcome-divider span { background: var(--bg-primary); padding: 0 0.4rem; position: relative; }

  .btn-primary {
    padding: 0.5rem 1rem;
    background: var(--accent-color);
    color: #fff; border: none; border-radius: 4px;
    cursor: pointer; font-size: var(--font-size-sm);
  }
  .btn-secondary {
    padding: 0.5rem 1rem;
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    border-radius: 4px; cursor: pointer; font-size: var(--font-size-sm);
  }
  .btn-link {
    background: transparent; border: none; color: var(--accent-color);
    cursor: pointer; font-size: var(--font-size-sm);
  }
  .btn-link:hover { text-decoration: underline; }

  .divider { border: none; border-top: 1px solid var(--border-light); margin: 0; }
</style>
