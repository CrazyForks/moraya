/**
 * MCP Server Presets - one-click add popular MCP servers
 */

import type { MCPServerConfig } from './types';

export interface MCPPresetEnvVar {
  name: string;
  /** i18n key for the env var description, resolved via $t() at display time */
  descriptionKey: string;
  isSecret: boolean;
  required: boolean;
}

export interface MCPPreset {
  id: string;
  name: string;
  /** i18n key for the preset description, resolved via $t() at display time */
  descriptionKey: string;
  /** Environment variables the user needs to provide before adding */
  envVars?: MCPPresetEnvVar[];
  /** Restrict this preset to a specific platform; undefined = all platforms */
  platform?: 'windows' | 'macos' | 'linux';
  createConfig: (envValues?: Record<string, string>) => Omit<MCPServerConfig, 'id'>;
}

export const MCP_PRESETS: MCPPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    descriptionKey: 'mcp.servers.presetDesc.filesystem',
    createConfig: () => ({
      name: 'Filesystem',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/'],
      },
      enabled: true,
    }),
  },
  {
    id: 'fetch',
    name: 'Fetch',
    descriptionKey: 'mcp.servers.presetDesc.fetch',
    createConfig: () => ({
      name: 'Fetch',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@tokenizin/mcp-npx-fetch'],
      },
      enabled: true,
    }),
  },
  {
    id: 'git',
    name: 'Git',
    descriptionKey: 'mcp.servers.presetDesc.git',
    createConfig: () => ({
      name: 'Git',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@cyanheads/git-mcp-server'],
      },
      enabled: true,
    }),
  },
  {
    id: 'memory',
    name: 'Memory',
    descriptionKey: 'mcp.servers.presetDesc.memory',
    createConfig: () => ({
      name: 'Memory',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
      enabled: true,
    }),
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    descriptionKey: 'mcp.servers.presetDesc.puppeteer',
    createConfig: () => ({
      name: 'Puppeteer',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      },
      enabled: true,
    }),
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    descriptionKey: 'mcp.servers.presetDesc.sqlite',
    createConfig: () => ({
      name: 'SQLite',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '~/test.db'],
      },
      enabled: true,
    }),
  },
  {
    id: 'slack',
    name: 'Slack',
    descriptionKey: 'mcp.servers.presetDesc.slack',
    envVars: [
      { name: 'SLACK_BOT_TOKEN', descriptionKey: 'mcp.servers.presetEnvDesc.slackBotToken', isSecret: true, required: true },
      { name: 'SLACK_TEAM_ID', descriptionKey: 'mcp.servers.presetEnvDesc.slackTeamId', isSecret: false, required: false },
    ],
    createConfig: (envValues) => ({
      name: 'Slack',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-slack'],
        env: envValues,
      },
      enabled: true,
    }),
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    descriptionKey: 'mcp.servers.presetDesc.googleMaps',
    envVars: [
      { name: 'GOOGLE_MAPS_API_KEY', descriptionKey: 'mcp.servers.presetEnvDesc.googleMapsApiKey', isSecret: true, required: true },
    ],
    createConfig: (envValues) => ({
      name: 'Google Maps',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-google-maps'],
        env: envValues,
      },
      enabled: true,
    }),
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    descriptionKey: 'mcp.servers.presetDesc.sequentialThinking',
    createConfig: () => ({
      name: 'Sequential Thinking',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      },
      enabled: true,
    }),
  },
  {
    id: 'everything',
    name: 'Everything',
    descriptionKey: 'mcp.servers.presetDesc.everything',
    platform: 'windows',
    createConfig: () => ({
      name: 'Everything',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
      },
      enabled: true,
    }),
  },
];
