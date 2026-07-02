<script lang="ts">
  /**
   * v0.60.0 — Export settings tab (PDF page setup + content toggles).
   *
   * The fields here drive the native print-to-PDF path. The canvas fallback
   * path uses jsPDF's fixed A4 portrait — it ignores these values and is
   * only ever invoked when the native path fails.
   */
  import { onDestroy } from 'svelte';
  import { settingsStore, type ExportSettings, type ExportPaperSize, type ExportOrientation } from '$lib/stores/settings-store';
  import { t } from '$lib/i18n';

  let settings: ExportSettings = $state({
    pageSize: 'a4',
    orientation: 'portrait',
    margins: { top: 20, right: 15, bottom: 20, left: 15 },
    headerEnabled: false,
    headerTemplate: '{title}',
    footerEnabled: true,
    footerTemplate: '{page} / {total}',
    fontFamily: '',
    fontSize: 11,
    enableHighlight: true,
    enableMermaid: true,
    enableMath: true,
    autoFallbackOnFailure: true,
  });

  const unsub = settingsStore.subscribe((s) => {
    if (s.exportSettings) {
      settings = {
        ...s.exportSettings,
        margins: { ...s.exportSettings.margins },
      };
    }
  });
  onDestroy(() => unsub());

  function persist(patch: Partial<ExportSettings>): void {
    const next: ExportSettings = {
      ...settings,
      ...patch,
      margins: patch.margins ? { ...patch.margins } : { ...settings.margins },
    };
    settings = next;
    settingsStore.update({ exportSettings: next });
  }

  function setMargin(side: 'top' | 'right' | 'bottom' | 'left', value: number): void {
    const v = isFinite(value) ? Math.max(0, Math.min(50, value)) : 0;
    persist({ margins: { ...settings.margins, [side]: v } });
  }

  const PAPER_OPTIONS: { value: ExportPaperSize; labelKey: string }[] = [
    { value: 'a4',     labelKey: 'settings.export.paper_a4' },
    { value: 'letter', labelKey: 'settings.export.paper_letter' },
    { value: 'legal',  labelKey: 'settings.export.paper_legal' },
    { value: 'a3',     labelKey: 'settings.export.paper_a3' },
    { value: 'a5',     labelKey: 'settings.export.paper_a5' },
  ];

  const FONT_SIZE_OPTIONS = [9, 10, 11, 12, 14];
</script>

<div class="export-settings">
  <!-- Header/intro removed: this component is now embedded inside the
       General settings card layout (v0.41.5), which provides the section
       title above the card. -->
  <div class="row">
    <label class="field">
      <span class="label">{$t('settings.export.paper_size')}</span>
      <select
        value={settings.pageSize}
        onchange={(e) => persist({ pageSize: (e.currentTarget as HTMLSelectElement).value as ExportPaperSize })}
      >
        {#each PAPER_OPTIONS as opt}
          <option value={opt.value}>{$t(opt.labelKey)}</option>
        {/each}
      </select>
    </label>

    <div class="field">
      <span class="label">{$t('settings.export.orientation')}</span>
      <div class="radio-group">
        <label>
          <input
            type="radio"
            name="orientation"
            checked={settings.orientation === 'portrait'}
            onchange={() => persist({ orientation: 'portrait' as ExportOrientation })}
          />
          {$t('settings.export.orientation_portrait')}
        </label>
        <label>
          <input
            type="radio"
            name="orientation"
            checked={settings.orientation === 'landscape'}
            onchange={() => persist({ orientation: 'landscape' as ExportOrientation })}
          />
          {$t('settings.export.orientation_landscape')}
        </label>
      </div>
    </div>
  </div>

  <fieldset class="group">
    <legend>{$t('settings.export.margins')}</legend>
    <div class="margins-row">
      <label class="field-inline">
        <span>{$t('settings.export.margins_top')}</span>
        <input
          type="number"
          min="0"
          max="50"
          step="1"
          value={settings.margins.top}
          onchange={(e) => setMargin('top', Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="unit">mm</span>
      </label>
      <label class="field-inline">
        <span>{$t('settings.export.margins_right')}</span>
        <input
          type="number" min="0" max="50" step="1"
          value={settings.margins.right}
          onchange={(e) => setMargin('right', Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="unit">mm</span>
      </label>
      <label class="field-inline">
        <span>{$t('settings.export.margins_bottom')}</span>
        <input
          type="number" min="0" max="50" step="1"
          value={settings.margins.bottom}
          onchange={(e) => setMargin('bottom', Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="unit">mm</span>
      </label>
      <label class="field-inline">
        <span>{$t('settings.export.margins_left')}</span>
        <input
          type="number" min="0" max="50" step="1"
          value={settings.margins.left}
          onchange={(e) => setMargin('left', Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="unit">mm</span>
      </label>
    </div>
  </fieldset>

  <fieldset class="group">
    <legend>{$t('settings.export.header_footer')}</legend>
    <label class="check">
      <input
        type="checkbox"
        checked={settings.headerEnabled}
        onchange={(e) => persist({ headerEnabled: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>{$t('settings.export.header_enabled')}</span>
    </label>
    <input
      type="text"
      class="template-input"
      disabled={!settings.headerEnabled}
      value={settings.headerTemplate}
      onchange={(e) => persist({ headerTemplate: (e.currentTarget as HTMLInputElement).value })}
    />

    <label class="check">
      <input
        type="checkbox"
        checked={settings.footerEnabled}
        onchange={(e) => persist({ footerEnabled: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>{$t('settings.export.footer_enabled')}</span>
    </label>
    <input
      type="text"
      class="template-input"
      disabled={!settings.footerEnabled}
      value={settings.footerTemplate}
      onchange={(e) => persist({ footerTemplate: (e.currentTarget as HTMLInputElement).value })}
    />

    <p class="hint">{$t('settings.export.template_hint')}</p>
  </fieldset>

  <fieldset class="group">
    <legend>{$t('settings.export.typography')}</legend>
    <label class="field">
      <span class="label">{$t('settings.export.font_family')}</span>
      <input
        type="text"
        placeholder={$t('settings.export.font_family_placeholder')}
        value={settings.fontFamily}
        onchange={(e) => persist({ fontFamily: (e.currentTarget as HTMLInputElement).value })}
      />
    </label>
    <label class="field">
      <span class="label">{$t('settings.export.font_size')}</span>
      <select
        value={settings.fontSize}
        onchange={(e) => persist({ fontSize: Number((e.currentTarget as HTMLSelectElement).value) })}
      >
        {#each FONT_SIZE_OPTIONS as size}
          <option value={size}>{size}pt</option>
        {/each}
      </select>
    </label>
  </fieldset>

  <fieldset class="group">
    <legend>{$t('settings.export.content')}</legend>
    <label class="check">
      <input
        type="checkbox"
        checked={settings.enableHighlight}
        onchange={(e) => persist({ enableHighlight: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>{$t('settings.export.enable_highlight')}</span>
    </label>
    <label class="check">
      <input
        type="checkbox"
        checked={settings.enableMath}
        onchange={(e) => persist({ enableMath: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>{$t('settings.export.enable_math')}</span>
    </label>
    <label class="check">
      <input
        type="checkbox"
        checked={settings.enableMermaid}
        onchange={(e) => persist({ enableMermaid: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>{$t('settings.export.enable_mermaid')}</span>
    </label>
  </fieldset>

  <fieldset class="group">
    <legend>{$t('settings.export.advanced')}</legend>
    <label class="check">
      <input
        type="checkbox"
        checked={settings.autoFallbackOnFailure}
        onchange={(e) => persist({ autoFallbackOnFailure: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>{$t('settings.export.auto_fallback')}</span>
    </label>
    <p class="hint">{$t('settings.export.auto_fallback_hint')}</p>
  </fieldset>
</div>

<style>
  /* Restyled to match the General-tab `.gx-*` system in SettingsPanel.svelte.
     Uses absolute pixel sizes (matching --font-size-sm = 14px, --font-size-xs
     = 12px) so the inherited body font size (~15px) can't scale them up. */
  .export-settings {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .row {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 180px;
  }
  .field .label {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    line-height: 1.3;
  }
  .field-inline {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .field-inline input[type='number'] {
    width: 64px;
  }
  .unit {
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
  }
  /* The fieldset/legend defaults to body font (~15px) and renders a heavy
     border + bordered legend. Strip both and use a small uppercase subhead
     identical to .gx-subhead in SettingsPanel for visual consistency. */
  .group {
    all: unset;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.55rem;
    border-top: 1px solid var(--border-light);
  }
  .group legend {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.1rem 0 0.15rem;
    margin: 0;
    float: none;
    width: auto;
  }
  .margins-row {
    display: flex;
    gap: 0.85rem;
    flex-wrap: wrap;
  }
  .radio-group {
    display: flex;
    gap: 1rem;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .radio-group label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }
  .check input {
    margin: 0;
  }
  .template-input {
    margin-left: 1.45rem;
    width: calc(100% - 1.45rem);
    max-width: 320px;
  }
  .template-input:disabled {
    opacity: 0.5;
  }
  .hint {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    margin: 0;
    line-height: 1.45;
  }
  select, input[type='text'], input[type='number'] {
    padding: 4px 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 5px;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
</style>
