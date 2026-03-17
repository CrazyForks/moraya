export type {
  AITemplate,
  AITemplateCategory,
  TemplateParam,
  TemplateParamOption,
  TemplateContext,
  FlowType,
  ContentSource,
  ResultAction,
  TemplateSource,
  TemplateExportFile,
  ExportableTemplate,
} from './types';

export { interpolate, resolveContent, buildTemplateMessages } from './engine';
export {
  getCategories,
  getTemplatesByCategory,
  getTemplateById,
  getAllTemplates,
  setCustomTemplates,
  getTemplateName,
  getTemplateDesc,
  getParamLabel,
  getOptionLabel,
} from './registry';
export { BUILTIN_CATEGORIES, BUILTIN_TEMPLATES } from './builtin-templates';
export {
  loadAllCustomTemplates,
  saveTemplate,
  deleteTemplate,
  importTemplatesFromFile,
  exportTemplates,
} from './template-storage';
