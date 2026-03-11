import './env/provider-env.ts';
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';
import { cmoAgent } from './agents/cmo-agent.ts';
import { croAgent } from './agents/cro-agent.ts';
import { executiveAssistantAgent } from './agents/executive-assistant-agent.ts';
import { newsReporterAgent } from './agents/news-reporter-agent.ts';
import { createRockoSimpleAuth as createAppSimpleAuth } from './auth/simple-auth.ts';
import { webSearchTool } from './tools/web-search-tool.ts';

export const mastra = new Mastra({
  agents: {
    cmoAgent,
    croAgent,
    executiveAssistantAgent,
    newsReporterAgent,
  },
  tools: {
    webSearchTool,
  },
  server: {
    auth: createAppSimpleAuth(),
  },
  storage: new LibSQLStore({
    id: 'mastra-storage',
    // stores observability, scores, ... into persistent file storage
    url: 'file:./mastra.db',
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
