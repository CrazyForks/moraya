/**
 * AI Template Registry — Stateful lookup with builtin + custom template merging
 */

import type { AITemplate, AITemplateCategory } from './types';
import { BUILTIN_CATEGORIES, BUILTIN_TEMPLATES } from './builtin-templates';

/** Custom templates loaded from disk (global + KB) */
let customTemplates: AITemplate[] = [];

const MY_TEMPLATES_CATEGORY: AITemplateCategory = {
  id: 'my_templates',
  icon: '📁',
  nameKey: 'templates.myTemplates.name',
  descKey: 'templates.myTemplates.desc',
  sortOrder: 0,
};

/** Called after loading custom templates from disk */
export function setCustomTemplates(templates: AITemplate[]): void {
  customTemplates = templates;
}

/** Get all categories, inserting "My Templates" if custom templates exist */
export function getCategories(): AITemplateCategory[] {
  const cats = BUILTIN_CATEGORIES.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  if (customTemplates.length > 0) {
    cats.unshift(MY_TEMPLATES_CATEGORY);
  }
  return cats;
}

/** Get templates by category. Custom templates override builtin by ID. */
export function getTemplatesByCategory(categoryId: string): AITemplate[] {
  if (categoryId === 'my_templates') {
    return customTemplates.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }
  const builtins = BUILTIN_TEMPLATES.filter(t => t.category === categoryId);
  // Custom templates with same ID override builtin
  const customIds = new Set(customTemplates.map(t => t.id));
  const merged = builtins.filter(t => !customIds.has(t.id));
  return merged.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/** Get a template by ID. Priority: KB > global > builtin */
export function getTemplateById(id: string): AITemplate | undefined {
  // Custom templates are sorted KB-first during loading
  const custom = customTemplates.find(t => t.id === id);
  if (custom) return custom;
  return BUILTIN_TEMPLATES.find(t => t.id === id);
}

/** Get all templates (merged, custom override builtin by ID) */
export function getAllTemplates(): AITemplate[] {
  const customIds = new Set(customTemplates.map(t => t.id));
  const builtins = BUILTIN_TEMPLATES.filter(t => !customIds.has(t.id));
  return [...customTemplates, ...builtins];
}

// ── Display name helpers ──

/** Resolve template display name: inline name > i18n key > id */
export function getTemplateName(tpl: AITemplate, t: (key: string) => string): string {
  return tpl.name ?? (tpl.nameKey ? t(tpl.nameKey) : tpl.id);
}

/** Resolve template display description: inline > i18n key > '' */
export function getTemplateDesc(tpl: AITemplate, t: (key: string) => string): string {
  return tpl.description ?? (tpl.descKey ? t(tpl.descKey) : '');
}

/** Resolve parameter label: inline > i18n key > key */
export function getParamLabel(param: { label?: string; labelKey?: string; key?: string }, t: (key: string) => string): string {
  return param.label ?? (param.labelKey ? t(param.labelKey) : param.key ?? '');
}

/** Resolve option label: inline > i18n key > value */
export function getOptionLabel(opt: { label?: string; labelKey?: string; value: string }, t: (key: string) => string): string {
  return opt.label ?? (opt.labelKey ? t(opt.labelKey) : opt.value);
}
