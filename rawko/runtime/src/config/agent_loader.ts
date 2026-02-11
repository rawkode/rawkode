import { basename, join, resolve } from "node:path";
import type { AgentPool } from "../types/agent.ts";
import { parseAgentDefinition } from "./frontmatter.ts";

export async function loadAgentPool(cwd = Deno.cwd()): Promise<AgentPool> {
  const searchRoots = await resolveAgentRoots(cwd);
  const orderedRoots = [...searchRoots.gitRoots, searchRoots.cwdRoot];

  const byBaseName = new Map<string, string>();
  for (const root of orderedRoots) {
    const files = await listAgentFiles(root);
    for (const file of files) {
      byBaseName.set(basename(file), file);
    }
  }

  if (byBaseName.size === 0) {
    throw new Error(
      `No agents found. Expected .mdx files in ${join(cwd, ".rawko", "agents")} or git root .rawko/agents`,
    );
  }

  const all = await Promise.all(
    [...byBaseName.values()].sort().map(async (filePath) => {
      const raw = await Deno.readTextFile(filePath);
      return parseAgentDefinition(filePath, raw);
    }),
  );

  const managers = all.filter((agent) => agent.manager);
  if (managers.length !== 1) {
    throw new Error(`Expected exactly one manager agent, found ${managers.length}`);
  }

  const council = all.filter((agent) => agent.council);
  if (council.length < 1) {
    throw new Error("Expected at least one council agent");
  }

  return {
    all,
    manager: managers[0],
    council,
    byId: new Map(all.map((agent) => [agent.id, agent])),
  };
}

async function resolveAgentRoots(cwd: string): Promise<{ cwdRoot: string; gitRoots: string[] }> {
  const cwdRoot = resolve(cwd, ".rawko", "agents");
  const gitRoot = await getGitRoot(cwd);
  if (!gitRoot) {
    return { cwdRoot, gitRoots: [] };
  }

  const gitAgentRoot = resolve(gitRoot, ".rawko", "agents");
  if (gitAgentRoot === cwdRoot) {
    return { cwdRoot, gitRoots: [] };
  }

  return { cwdRoot, gitRoots: [gitAgentRoot] };
}

async function listAgentFiles(root: string): Promise<string[]> {
  try {
    const entries: string[] = [];
    for await (const entry of Deno.readDir(root)) {
      if (entry.isFile && entry.name.endsWith(".mdx")) {
        entries.push(resolve(root, entry.name));
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function getGitRoot(cwd: string): Promise<string | null> {
  const command = new Deno.Command("git", {
    args: ["rev-parse", "--show-toplevel"],
    cwd,
    stdout: "piped",
    stderr: "null",
  });

  try {
    const output = await command.output();
    if (!output.success) {
      return null;
    }
    const root = new TextDecoder().decode(output.stdout).trim();
    return root.length > 0 ? resolve(root) : null;
  } catch {
    return null;
  }
}
