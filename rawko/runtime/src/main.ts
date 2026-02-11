#!/usr/bin/env -S deno run -A

import process from "node:process";
import readline from "node:readline";
import { once } from "node:events";
import { createClientWithDriver } from "rivetkit";
import { rawkoRegistry, HEALTH_ACTOR_KEY, MANAGER_ACTOR_KEY, USER_ACTOR_KEY } from "./actors/registry.ts";
import { loadAgentPool } from "./config/agent_loader.ts";
import { startRuntimeServer } from "./http/server.ts";
import { ProviderFactory } from "./providers/factory.ts";
import { setRuntimeDependencies } from "./runtime/dependencies.ts";
import { EventStore } from "./runtime/event_store.ts";
import { AgentExecutor } from "./runtime/executor.ts";
import type { ProviderName } from "./types/agent.ts";
import { err, log } from "./util/logger.ts";

interface CliArgs {
  help: boolean;
  host: string;
  port: number;
  maxParallel: number;
  healthIntervalMs: number;
  prewarm: boolean;
  stdin: boolean;
  promptParts: string[];
}

interface ShutdownState {
  shuttingDown: boolean;
}

export async function run(): Promise<void> {
  const args = parseArgs(Deno.args);
  if (args.help) {
    printHelp();
    return;
  }

  const cwd = Deno.cwd();
  const pool = await loadAgentPool(cwd);
  const events = new EventStore();

  const providerFactory = new ProviderFactory();
  if (args.prewarm) {
    await providerFactory.prewarm(getProvidersInUse(pool));
  }

  const executor = new AgentExecutor(providerFactory, cwd, {
    immediateRetries: 4,
    onInvokeAttempt: (meta) => {
      events.append({
        type: "invoke_attempt",
        agentId: meta.agentId,
        agentName: meta.agentName,
        provider: meta.provider,
        model: meta.model,
        attempt: meta.attempt,
        maxAttempts: meta.maxAttempts,
        probe: meta.probe,
      });
    },
    onInvokeFailure: (meta) => {
      events.append({
        type: "invoke_failure",
        agentId: meta.agentId,
        agentName: meta.agentName,
        provider: meta.provider,
        model: meta.model,
        attempt: meta.attempt,
        maxAttempts: meta.maxAttempts,
        probe: meta.probe,
        reason: meta.reason,
      });
    },
    onOffSick: (agentId, agentName, reason) => {
      events.append({
        type: "agent_state",
        agentId,
        agentName,
        state: "off_sick",
        detail: reason,
      });
      events.append({
        type: "chat",
        role: "system",
        text: `${agentName} off sick: ${reason}`,
      });
    },
    onRecovered: (agentId, agentName) => {
      events.append({
        type: "agent_state",
        agentId,
        agentName,
        state: "idle",
      });
      events.append({
        type: "chat",
        role: "system",
        text: `${agentName} recovered and is available`,
      });
    },
  });

  setRuntimeDependencies({
    pool,
    executor,
    events,
    maxParallelWorkers: args.maxParallel,
  });

  const parsed = rawkoRegistry.parseConfig();
  if (!parsed.driver) {
    throw new Error("Rivet registry driver is required");
  }
  const managerDriver = parsed.driver.manager(parsed);
  const client = createClientWithDriver<typeof rawkoRegistry>(managerDriver, {});

  const managerHandle = client.manager.getOrCreate(MANAGER_ACTOR_KEY);
  const userHandle = client.user.getOrCreate(USER_ACTOR_KEY);
  const healthHandle = client.health.getOrCreate(HEALTH_ACTOR_KEY);

  await managerHandle.bootstrap({
    initialObjective: args.promptParts.length > 0 ? args.promptParts.join(" ") : undefined,
    maxParallelWorkers: args.maxParallel,
  });

  events.append({
    type: "chat",
    role: "system",
    text: `Runtime ready. manager=${pool.manager.name} agents=${pool.all.length} council=${pool.council.length}`,
  });

  const shutdownState: ShutdownState = { shuttingDown: false };
  let runCycleInFlight = false;
  const cycleTimer = setInterval(async () => {
    if (shutdownState.shuttingDown || runCycleInFlight) {
      return;
    }

    runCycleInFlight = true;
    try {
      await managerHandle.runCycle();
    } catch (error) {
      events.append({
        type: "chat",
        role: "system",
        text: `runCycle error: ${stringifyError(error)}`,
      });
    } finally {
      runCycleInFlight = false;
    }
  }, 250);

  const healthTimer = setInterval(async () => {
    if (shutdownState.shuttingDown) {
      return;
    }

    try {
      await healthHandle.tick();
    } catch (error) {
      events.append({
        type: "chat",
        role: "system",
        text: `health tick error: ${stringifyError(error)}`,
      });
    }
  }, args.healthIntervalMs);

  const userActor = args.stdin
    ? startUserInput({
      submit: async (text: string) => await userHandle.submit(text),
    })
    : null;

  const shutdown = async () => {
    if (shutdownState.shuttingDown) {
      return;
    }
    shutdownState.shuttingDown = true;

    clearInterval(cycleTimer);
    clearInterval(healthTimer);

    if (userActor) {
      userActor.close();
      await userActor.done;
    }

    await managerHandle.stop();
    await client.dispose();
    await server.shutdown();
  };

  const server = startRuntimeServer({
    host: args.host,
    port: args.port,
    events,
    handles: {
      manager: {
        setObjective: (text: string) => managerHandle.setObjective(text),
        getSnapshot: () => managerHandle.getSnapshot(),
        stop: () => managerHandle.stop(),
      },
      user: {
        submit: async (text: string) => await userHandle.submit(text),
      },
      health: {
        tick: async () => await healthHandle.tick(),
      },
    },
    onShutdown: shutdown,
  });

  log(`Runtime listening on http://${args.host}:${args.port}`);

  const sigInt = () => {
    void shutdown().finally(() => {
      Deno.exit(0);
    });
  };
  Deno.addSignalListener("SIGINT", sigInt);

  try {
    await server.finished;
  } finally {
    Deno.removeSignalListener("SIGINT", sigInt);
    await shutdown();
  }
}

interface UserInputHandle {
  close: () => void;
  done: Promise<void>;
}

function startUserInput(userHandle: { submit: (text: string) => Promise<{ accepted: boolean }> }): UserInputHandle {
  const interactive = Deno.stdin.isTerminal();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  });

  if (interactive) {
    rl.setPrompt("you> ");
    rl.prompt();
  }

  rl.on("line", async (line) => {
    try {
      await userHandle.submit(line);
    } catch (error) {
      err(`stdin submit failed: ${stringifyError(error)}`);
    }

    if (interactive) {
      rl.prompt();
    }
  });

  const done = (async () => {
    await once(rl, "close");
  })();

  return {
    close: () => rl.close(),
    done,
  };
}

function parseArgs(argv: string[]): CliArgs {
  let help = false;
  let host = "127.0.0.1";
  let port = 8788;
  let maxParallel = 4;
  let healthIntervalMs = 5 * 60 * 1000;
  let prewarm = true;
  let stdin = true;

  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }

    if (arg === "--host") {
      host = requireValue(argv, ++i, "--host");
      continue;
    }

    if (arg === "--port") {
      port = parsePositiveInt(requireValue(argv, ++i, "--port"), "--port");
      continue;
    }

    if (arg === "--max-parallel") {
      maxParallel = parsePositiveInt(requireValue(argv, ++i, "--max-parallel"), "--max-parallel");
      continue;
    }

    if (arg === "--health-interval-ms") {
      healthIntervalMs = parsePositiveInt(requireValue(argv, ++i, "--health-interval-ms"), "--health-interval-ms");
      continue;
    }

    if (arg === "--no-prewarm") {
      prewarm = false;
      continue;
    }

    if (arg === "--no-stdin") {
      stdin = false;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    promptParts.push(arg);
  }

  return {
    help,
    host,
    port,
    maxParallel,
    healthIntervalMs,
    prewarm,
    stdin,
    promptParts,
  };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function getProvidersInUse(pool: Awaited<ReturnType<typeof loadAgentPool>>): Set<ProviderName> {
  const providers = new Set<ProviderName>();
  for (const agent of pool.all) {
    for (const route of agent.models) {
      providers.add(route.provider);
    }
  }
  return providers;
}

function printHelp(): void {
  console.log("rawko runtime (Rivet actors + native SDK providers)");
  console.log("");
  console.log("Usage:");
  console.log("  deno task run -- \"Build X\"");
  console.log("  deno task run -- --port 8788");
  console.log("");
  console.log("Options:");
  console.log("  --host <host>                bind host (default 127.0.0.1)");
  console.log("  --port <port>                bind port (default 8788)");
  console.log("  --max-parallel <n>           max concurrent workers (default 4)");
  console.log("  --health-interval-ms <ms>    off-sick probe interval (default 300000)");
  console.log("  --no-prewarm                 skip provider prewarm");
  console.log("  --no-stdin                   disable terminal input actor");
  console.log("  -h, --help                   show help");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

if (import.meta.main) {
  run().catch((error) => {
    err(stringifyError(error));
    Deno.exit(1);
  });
}
