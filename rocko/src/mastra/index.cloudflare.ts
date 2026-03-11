import './env/provider-env.ts';
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { D1Store } from '@mastra/cloudflare-d1';
import { CloudflareDeployer } from '@mastra/deployer-cloudflare';
import { cmoAgent } from './agents/cmo-agent.ts';
import { croAgent } from './agents/cro-agent.ts';
import { executiveAssistantAgent } from './agents/executive-assistant-agent.ts';
import { newsReporterAgent } from './agents/news-reporter-agent.ts';
import { createRockoSimpleAuth } from './auth/simple-auth.ts';
import { buildCloudflareRouteConfig, getRockoPublicUrl } from './cloudflare/route-config.ts';
import { webSearchTool } from './tools/web-search-tool.ts';

const requiredEnv = (name: string) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required Cloudflare deployment env var: ${name}`);
  }

  return value;
};

const workerName = process.env.CLOUDFLARE_WORKER_NAME ?? 'rocko-mastra';
const d1Binding = process.env.CLOUDFLARE_D1_BINDING ?? 'D1Database';
const d1DatabaseName = requiredEnv('CLOUDFLARE_D1_DATABASE_NAME');
const d1DatabaseId = requiredEnv('CLOUDFLARE_D1_DATABASE_ID');
const publicUrl = getRockoPublicUrl();

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
    auth: createRockoSimpleAuth(),
  },
  storage: new D1Store({
    id: 'mastra-storage',
    accountId: requiredEnv('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: requiredEnv('CLOUDFLARE_API_TOKEN'),
    databaseId: d1DatabaseId,
    tablePrefix: process.env.CLOUDFLARE_D1_TABLE_PREFIX ?? 'rocko_',
    disableInit: process.env.CLOUDFLARE_D1_DISABLE_INIT === '1',
  }),
  deployer: new CloudflareDeployer({
    name: workerName,
    compatibility_date:
      process.env.CLOUDFLARE_COMPATIBILITY_DATE ?? '2026-03-11',
    compatibility_flags: [
      'nodejs_compat',
      'nodejs_compat_populate_process_env',
    ],
    d1_databases: [
      {
        binding: d1Binding,
        database_name: d1DatabaseName,
        database_id: d1DatabaseId,
      },
    ],
    assets: {
      directory: './studio',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*'],
    },
    ...buildCloudflareRouteConfig(),
    vars: {
      CLOUDFLARE_ACCOUNT_ID: requiredEnv('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_D1_DATABASE_ID: d1DatabaseId,
      CLOUDFLARE_D1_DATABASE_NAME: d1DatabaseName,
      CLOUDFLARE_D1_TABLE_PREFIX:
        process.env.CLOUDFLARE_D1_TABLE_PREFIX ?? 'rocko_',
      ROCKO_PUBLIC_URL: publicUrl.toString(),
    },
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: process.env.LOG_LEVEL ?? 'info',
  }),
});
