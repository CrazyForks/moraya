/**
 * AI Template System — Domain Model
 *
 * Configuration-driven AI interaction templates.
 * All 71+ templates are defined as JSON-like objects; adding new templates requires zero code changes.
 */

/** Interaction flow type */
export type FlowType =
  | 'auto'           // Auto-execute: resolve content → send immediately
  | 'input'          // Text input: show input box → user types → send
  | 'selection'      // Option selection: show options → user picks → send
  | 'parameterized'  // Parameter config: multi-param panel → user configures → send
  | 'interactive';   // Multi-turn: send initial prompt → enter free chat mode

/** Where to get editor content from */
export type ContentSource =
  | 'none'                   // No editor content needed
  | 'document'               // Current document content (last 3000 chars)
  | 'selection'              // Selected text (error if none)
  | 'document_or_selection'; // Prefer selection, fall back to document

/** What actions to show on AI response */
export type ResultAction = 'insert' | 'replace' | 'copy' | 'none';

/** Template source: builtin, global custom, or per-KB custom */
export type TemplateSource = 'builtin' | 'global' | 'kb';

/** A single option within a template parameter */
export interface TemplateParamOption {
  value: string;
  labelKey?: string;  // i18n key (builtin templates)
  label?: string;     // inline label (custom templates)
}

/** A configurable parameter for parameterized/selection templates */
export interface TemplateParam {
  key: string;                    // Used in prompt interpolation: {{param.key}}
  labelKey?: string;              // i18n key for the parameter label (builtin)
  label?: string;                 // inline label (custom templates)
  type: 'select' | 'radio';      // Dropdown or radio group
  options: TemplateParamOption[];
  default: string;                // Default value (must be one of options[].value)
}

/** Core template definition */
export interface AITemplate {
  id: string;                     // Unique ID: "category.name"
  category: string;               // Category ID
  icon: string;                   // Display icon (emoji)
  nameKey?: string;               // i18n key for template name (builtin)
  descKey?: string;               // i18n key for template description (builtin)
  name?: string;                  // inline name (custom templates)
  description?: string;           // inline description (custom templates)
  flow: FlowType;
  contentSource: ContentSource;
  inputHintKey?: string;          // i18n key for input placeholder (builtin)
  inputHint?: string;             // inline input hint (custom templates)
  params?: TemplateParam[];       // Parameters (parameterized/selection flow)
  systemPrompt: string;           // System prompt sent to AI (English)
  userPromptTemplate: string;     // User prompt with {{}} interpolation
  defaultActions: ResultAction[]; // Action buttons on response
  tags?: string[];                // Search tags
  sortOrder?: number;             // Sort weight within category
  /** Runtime-only: set during loading, not persisted */
  source?: TemplateSource;
  /** Runtime-only: file path for custom templates */
  sourcePath?: string;
  /** Version string for exported templates */
  version?: string;
  /** Author name for exported templates */
  author?: string;
}

/** Export file format for sharing templates */
export interface TemplateExportFile {
  version: '1.0';
  templates: ExportableTemplate[];
}

/** Template fields included in export (excludes runtime fields) */
export type ExportableTemplate = Omit<AITemplate, 'source' | 'sourcePath'>;

/** Template category definition */
export interface AITemplateCategory {
  id: string;
  icon: string;
  nameKey: string;   // i18n key for category name
  descKey: string;   // i18n key for category description
  sortOrder: number;
}

/** Context for prompt interpolation */
export interface TemplateContext {
  content?: string;                       // Editor content (resolved by contentSource)
  input?: string;                         // User-typed text (input flow)
  params?: Record<string, string>;        // Parameter values
  paramLabels?: Record<string, string>;   // Localized parameter labels
  locale?: string;                        // Current locale code
}
