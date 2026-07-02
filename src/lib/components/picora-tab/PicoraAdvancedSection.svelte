<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { ImageHostTarget } from '$lib/services/image-hosting';

  const tr = $t;

  let picoraTargets = $state<ImageHostTarget[]>([]);
  let defaultPicoraId = $state('');
  let picoraSidebarPinned = $state(false);
  let picoraDebugLogging = $state(false);
  let picoraRewriteBase64 = $state(false);

  const unsub = settingsStore.subscribe(s => {
    picoraTargets = (s.imageHostTargets || []).filter(t => t.provider === 'picora');
    defaultPicoraId = s.defaultPicoraAccountId || '';
    picoraSidebarPinned = s.picoraSidebarPinned;
    picoraDebugLogging = s.picoraDebugLogging;
    picoraRewriteBase64 = s.picoraRewriteBase64;
  });
  onDestroy(() => { unsub(); });

  let defaultTarget = $derived(picoraTargets.find(t => t.id === defaultPicoraId) ?? picoraTargets[0]);

  function setImgDomain(value: string) {
    if (!defaultTarget) return;
    const updated = picoraTargets.map(t => t.id === defaultTarget!.id ? { ...t, picoraImgDomain: value } : t);
    settingsStore.update({
      imageHostTargets: settingsStore.getState().imageHostTargets.map(t => {
        const repl = updated.find(u => u.id === t.id);
        return repl ?? t;
      }),
    });
  }
</script>

<section class="advanced-section">
  <header class="section-header">
    <h3>{tr('settings.picora.advanced.title')}</h3>
  </header>

  {#if defaultTarget}
    <div class="field">
      <label for="picora-img-domain">{tr('settings.picora.advanced.img_domain')}</label>
      <input
        id="picora-img-domain"
        type="text"
        value={defaultTarget.picoraImgDomain}
        onchange={(e) => setImgDomain((e.target as HTMLInputElement).value)}
      />
      <p class="hint">{tr('settings.picora.advanced.img_domain_hint')}</p>
    </div>
  {/if}

  <label class="toggle-row">
    <input
      type="checkbox"
      checked={picoraRewriteBase64}
      onchange={(e) => settingsStore.update({ picoraRewriteBase64: (e.target as HTMLInputElement).checked })}
    />
    <span>{tr('settings.picora.advanced.rewrite_base64')}</span>
  </label>

  <label class="toggle-row">
    <input
      type="checkbox"
      checked={picoraSidebarPinned}
      onchange={(e) => settingsStore.update({ picoraSidebarPinned: (e.target as HTMLInputElement).checked })}
    />
    <span>{tr('settings.picora.advanced.sidebar_pin')}</span>
  </label>

  <label class="toggle-row">
    <input
      type="checkbox"
      checked={picoraDebugLogging}
      onchange={(e) => settingsStore.update({ picoraDebugLogging: (e.target as HTMLInputElement).checked })}
    />
    <span>{tr('settings.picora.advanced.debug')}</span>
  </label>
</section>

<style>
  .advanced-section { display: flex; flex-direction: column; gap: 0.6rem; }
  .section-header h3 { margin: 0; font-size: var(--font-size-base); font-weight: 600; color: var(--text-primary); }
  .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .field label { font-size: var(--font-size-xs); color: var(--text-muted); }
  .field input {
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    max-width: 380px;
  }
  .hint { margin: 0; font-size: var(--font-size-xs); color: var(--text-muted); }
  .toggle-row { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: var(--font-size-sm); color: var(--text-secondary); }
</style>
