import { invoke } from '@tauri-apps/api/core';
import { settingsStore } from '$lib/stores/settings-store';
import { filesStore } from '$lib/stores/files-store';
import { aiStore } from '$lib/services/ai/ai-service';
import type { EmbeddingConfig, IndexStatus, SearchResult } from './types';
import { EMBEDDING_MODELS, getDefaultEmbeddingModel, getMaxDimension } from './types';

/** Build the EmbeddingConfig from current settings, or null if not configured */
export function getEmbeddingConfig(): EmbeddingConfig | null {
  const s = settingsStore.getState();
  const aiState = aiStore.getState();
  const activeAIConfig = aiStore.getActiveConfig();

  // Local model mode
  if (s.embeddingProvider === 'local') {
    const modelId = s.localEmbeddingModelId;
    if (!modelId) return null;
    return {
      configId: '',
      provider: 'local',
      model: modelId,
      dimensions: 0, // determined by local model
    };
  }

  // Online API mode: use dedicated embedding provider or fall back to AI chat provider
  let provider = s.embeddingProvider || '';
  if (!provider) {
    const aiProvider = activeAIConfig?.provider || '';
    if (aiProvider && EMBEDDING_MODELS[aiProvider]) {
      provider = aiProvider;
    } else {
      return null;
    }
  }

  let model = s.embeddingModel;
  if (!model) {
    const preset = getDefaultEmbeddingModel(provider);
    if (!preset) return null;
    model = preset.model;
  }

  const maxDim = getMaxDimension(provider, model);
  const userDim = s.embeddingDimensions || 1024;
  const dimensions = Math.min(userDim, maxDim);
  const configId = s.embeddingConfigId || aiState.activeConfigId || '';
  const baseUrl = s.embeddingBaseUrl || undefined;

  return { configId, provider, model, dimensions, baseUrl };
}

/** Index all (or specified) documents in a knowledge base */
export async function indexKnowledgeBase(
  kbPath: string,
  config: EmbeddingConfig,
  filePaths?: string[],
): Promise<IndexStatus> {
  const result = await invoke<{
    indexed: boolean;
    chunk_count: number;
    file_count: number;
    model_id: string;
    dimensions: number;
    last_updated: string | null;
    stale_files: string[];
  }>('kb_index_files', {
    kbPath,
    configId: config.configId,
    keyPrefix: 'ai-key:',
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    baseUrl: config.baseUrl ?? null,
    filePaths: filePaths ?? null,
  });

  return mapIndexStatus(result);
}

/** Search the knowledge base */
export async function searchKnowledgeBase(
  kbPath: string,
  query: string,
  config: EmbeddingConfig,
  topK = 10,
  mode = 'hybrid',
): Promise<SearchResult[]> {
  const results = await invoke<Array<{
    file_path: string;
    heading: string | null;
    preview: string;
    score: number;
    offset: number;
    source: string;
  }>>('kb_search', {
    kbPath,
    query,
    configId: config.configId,
    keyPrefix: 'ai-key:',
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    baseUrl: config.baseUrl ?? null,
    topK,
    mode,
  });

  return results.map((r) => ({
    filePath: r.file_path,
    heading: r.heading ?? undefined,
    preview: r.preview,
    score: r.score,
    offset: r.offset,
    source: r.source as SearchResult['source'],
  }));
}

/** Get index status for the active knowledge base */
export async function getIndexStatus(kbPath: string): Promise<IndexStatus> {
  const result = await invoke<{
    indexed: boolean;
    chunk_count: number;
    file_count: number;
    model_id: string;
    dimensions: number;
    last_updated: string | null;
    stale_files: string[];
  }>('kb_get_index_status', { kbPath });

  return mapIndexStatus(result);
}

/** Delete the index for a knowledge base */
export async function deleteIndex(kbPath: string): Promise<void> {
  await invoke('kb_delete_index', { kbPath });
}

/** Index a single file (for auto-index on save) */
export async function indexSingleFile(
  kbPath: string,
  filePath: string,
  config: EmbeddingConfig,
): Promise<void> {
  await invoke('kb_index_single_file', {
    kbPath,
    filePath,
    configId: config.configId,
    keyPrefix: 'ai-key:',
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    baseUrl: config.baseUrl ?? null,
  });
}

/** Auto-index a file on save if conditions are met */
export async function autoIndexOnSave(filePath: string): Promise<void> {
  const settings = settingsStore.getState();
  if (!settings.autoIndexOnSave) return;

  const config = getEmbeddingConfig();
  if (!config) return;

  // Find which KB this file belongs to
  const fsState = filesStore.getState();
  const kb = fsState.knowledgeBases.find((kb) => filePath.startsWith(kb.path));
  if (!kb) return;

  try {
    await indexSingleFile(kb.path, filePath, config);
  } catch {
    // Silently fail — auto-index is best-effort
  }
}

// Map snake_case Rust response to camelCase TS
function mapIndexStatus(r: {
  indexed: boolean;
  chunk_count: number;
  file_count: number;
  model_id: string;
  dimensions: number;
  last_updated: string | null;
  stale_files: string[];
}): IndexStatus {
  return {
    indexed: r.indexed,
    chunkCount: r.chunk_count,
    fileCount: r.file_count,
    modelId: r.model_id,
    dimensions: r.dimensions,
    lastUpdated: r.last_updated ?? undefined,
    staleFiles: r.stale_files,
  };
}
