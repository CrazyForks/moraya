import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted ABOVE imports, so we use vi.hoisted to
// build a tiny pub-sub store that's compatible with svelte's `get()`
// (only needs `.subscribe(cb)`).
const mocks = vi.hoisted(() => {
  function makeStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(cb: (v: T) => void) {
        subs.add(cb);
        cb(value);
        return () => subs.delete(cb);
      },
      set(v: T) {
        value = v;
        subs.forEach(cb => cb(value));
      },
      get(): T { return value; },
    };
  }
  const store = makeStore({
    servers: [] as Array<{ id: string; name: string; enabled: boolean; transport: unknown }>,
    connectedServers: new Set<string>(),
    tools: [] as Array<{ name: string; serverId: string; description: string; inputSchema: Record<string, unknown> }>,
    resources: [] as unknown[],
    publishTargets: [] as unknown[],
    syncConfigs: [] as unknown[],
    syncStatuses: new Map(),
    isLoading: false,
    error: null,
  });
  const tStore = makeStore((key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key
  );
  return {
    mockStore: store,
    tStore,
    connectServerMock: vi.fn(async (_: unknown) => {}),
    disconnectServerMock: vi.fn(async (_: string) => {}),
  };
});

vi.mock('./mcp-manager', () => ({
  mcpStore: mocks.mockStore,
  connectServer: mocks.connectServerMock,
  disconnectServer: mocks.disconnectServerMock,
}));

vi.mock('$lib/i18n', () => ({ t: mocks.tStore }));

const { mockStore, connectServerMock, disconnectServerMock } = mocks;

import { toggleMCPServer, resolveMCPToolPrompt } from './shortcut-actions';

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.set({
    servers: [],
    connectedServers: new Set(),
    tools: [],
    resources: [],
    publishTargets: [],
    syncConfigs: [],
    syncStatuses: new Map(),
    isLoading: false,
    error: null,
  });
});

describe('toggleMCPServer', () => {
  it('connects when the server is currently disconnected', async () => {
    mockStore.set({

      servers: [{ id: 'mcp-1', name: 'Filesystem', enabled: false, transport: { type: 'stdio' } }],
      connectedServers: new Set(),
      tools: [],
      resources: [],
      publishTargets: [],
      syncConfigs: [],
      syncStatuses: new Map(),
      isLoading: false,
      error: null,
    });
    const result = await toggleMCPServer('mcp-1');
    expect(result.kind).toBe('connected');
    expect(connectServerMock).toHaveBeenCalledTimes(1);
    expect(disconnectServerMock).not.toHaveBeenCalled();
    if (result.kind === 'connected') expect(result.server.id).toBe('mcp-1');
  });

  it('disconnects when the server is currently connected', async () => {
    mockStore.set({

      servers: [{ id: 'mcp-1', name: 'Filesystem', enabled: true, transport: { type: 'stdio' } }],
      connectedServers: new Set(['mcp-1']),
      tools: [],
      resources: [],
      publishTargets: [],
      syncConfigs: [],
      syncStatuses: new Map(),
      isLoading: false,
      error: null,
    });
    const result = await toggleMCPServer('mcp-1');
    expect(result.kind).toBe('disconnected');
    expect(disconnectServerMock).toHaveBeenCalledWith('mcp-1');
    expect(connectServerMock).not.toHaveBeenCalled();
  });

  it('returns not-found when the server id is unknown', async () => {
    const result = await toggleMCPServer('ghost-id');
    expect(result.kind).toBe('not-found');
    expect(connectServerMock).not.toHaveBeenCalled();
    expect(disconnectServerMock).not.toHaveBeenCalled();
  });

  it('returns error when underlying connect throws', async () => {
    connectServerMock.mockRejectedValueOnce(new Error('boom'));
    mockStore.set({

      servers: [{ id: 'mcp-1', name: 'Filesystem', enabled: false, transport: { type: 'stdio' } }],
      connectedServers: new Set(),
      tools: [],
      resources: [],
      publishTargets: [],
      syncConfigs: [],
      syncStatuses: new Map(),
      isLoading: false,
      error: null,
    });
    const result = await toggleMCPServer('mcp-1');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.reason).toBe('boom');
  });
});

describe('resolveMCPToolPrompt', () => {
  it('returns ok with localized message body', () => {
    mockStore.set({

      servers: [{ id: 'mcp-1', name: 'Filesystem', enabled: true, transport: { type: 'stdio' } }],
      connectedServers: new Set(['mcp-1']),
      tools: [{ name: 'read_file', serverId: 'mcp-1', description: 'Read a file', inputSchema: {} }],
      resources: [],
      publishTargets: [],
      syncConfigs: [],
      syncStatuses: new Map(),
      isLoading: false,
      error: null,
    });
    const result = resolveMCPToolPrompt('mcp-1', 'read_file');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.server.name).toBe('Filesystem');
      expect(result.tool.name).toBe('read_file');
      expect(result.message).toContain('ai.prompts.mcp_tool_prompt');
      expect(result.message).toContain('read_file');
      expect(result.message).toContain('Filesystem');
    }
  });

  it('returns not-found when the server is gone', () => {
    const result = resolveMCPToolPrompt('mcp-1', 'read_file');
    expect(result.kind).toBe('not-found');
  });

  it('returns not-found when the tool is gone', () => {
    mockStore.set({

      servers: [{ id: 'mcp-1', name: 'Filesystem', enabled: true, transport: { type: 'stdio' } }],
      connectedServers: new Set(['mcp-1']),
      tools: [], // server present but tool removed
      resources: [],
      publishTargets: [],
      syncConfigs: [],
      syncStatuses: new Map(),
      isLoading: false,
      error: null,
    });
    const result = resolveMCPToolPrompt('mcp-1', 'read_file');
    expect(result.kind).toBe('not-found');
  });
});
