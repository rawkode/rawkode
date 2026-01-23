/**
 * Plan persistence for rawko-sdk
 * Saves and loads plans from disk.
 */

import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Plan } from "./types.ts";

/**
 * Get the plans directory path.
 */
export function getPlansDir(): string {
  return path.join(Deno.cwd(), ".rawko", "plans");
}

/**
 * Ensure the plans directory exists.
 */
export async function ensurePlansDir(): Promise<void> {
  const dir = getPlansDir();
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      throw error;
    }
  }
}

/**
 * Save a plan to disk.
 */
export async function savePlan(plan: Plan): Promise<string> {
  await ensurePlansDir();

  const filename = `${plan.id}.yaml`;
  const filepath = path.join(getPlansDir(), filename);

  const content = stringifyYaml(plan as unknown as Record<string, unknown>);
  await Deno.writeTextFile(filepath, content);

  return filepath;
}

/**
 * Load a plan by ID.
 */
export async function loadPlan(planId: string): Promise<Plan | null> {
  const filename = `${planId}.yaml`;
  const filepath = path.join(getPlansDir(), filename);

  try {
    const content = await Deno.readTextFile(filepath);
    return parseYaml(content) as Plan;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

/**
 * Delete a plan from disk.
 */
export async function deletePlan(planId: string): Promise<boolean> {
  const filename = `${planId}.yaml`;
  const filepath = path.join(getPlansDir(), filename);

  try {
    await Deno.remove(filepath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

/**
 * List all saved plans.
 */
export async function listPlans(): Promise<Plan[]> {
  const dir = getPlansDir();
  const plans: Plan[] = [];

  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".yaml")) {
        const filepath = path.join(dir, entry.name);
        try {
          const content = await Deno.readTextFile(filepath);
          const plan = parseYaml(content) as Plan;
          plans.push(plan);
        } catch {
          // Skip invalid files
        }
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }

  // Sort by updatedAt descending (most recent first)
  return plans.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Find plans by status.
 */
export async function findPlansByStatus(
  status: Plan["status"]
): Promise<Plan[]> {
  const plans = await listPlans();
  return plans.filter((p) => p.status === status);
}

/**
 * Find plans by task (partial match).
 */
export async function findPlansByTask(taskQuery: string): Promise<Plan[]> {
  const plans = await listPlans();
  const query = taskQuery.toLowerCase();
  return plans.filter((p) => p.task.toLowerCase().includes(query));
}

/**
 * Get the most recent plan (by updatedAt).
 */
export async function getMostRecentPlan(): Promise<Plan | null> {
  const plans = await listPlans();
  return plans[0] ?? null;
}

/**
 * Get plan history (all versions of a plan).
 */
export async function getPlanHistory(planId: string): Promise<Plan[]> {
  const plans = await listPlans();

  // Extract base ID (without version suffix)
  const baseId = planId.replace(/-v\d+$/, "");

  // Find all versions
  const versions = plans.filter(
    (p) => p.id === baseId || p.id.startsWith(`${baseId}-v`)
  );

  // Sort by version ascending
  return versions.sort((a, b) => a.version - b.version);
}

/**
 * Archive a completed plan (move to archives subdirectory).
 */
export async function archivePlan(planId: string): Promise<boolean> {
  const sourcePath = path.join(getPlansDir(), `${planId}.yaml`);
  const archiveDir = path.join(getPlansDir(), "archive");
  const destPath = path.join(archiveDir, `${planId}.yaml`);

  try {
    // Ensure archive directory exists
    await Deno.mkdir(archiveDir, { recursive: true });

    // Move file
    await Deno.rename(sourcePath, destPath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

/**
 * Current task tracking file operations.
 */
const CURRENT_TASK_FILE = ".rawko/current-task.yaml";

interface CurrentTask {
  task: string;
  planId: string;
  status: string;
  startedAt: string;
}

/**
 * Set the current active task and plan.
 */
export async function setCurrentTask(
  task: string,
  planId: string
): Promise<void> {
  const current: CurrentTask = {
    task,
    planId,
    status: "in_progress",
    startedAt: new Date().toISOString(),
  };

  const content = stringifyYaml(current as unknown as Record<string, unknown>);
  await Deno.writeTextFile(
    path.join(Deno.cwd(), CURRENT_TASK_FILE),
    content
  );
}

/**
 * Get the current active task.
 */
export async function getCurrentTask(): Promise<CurrentTask | null> {
  try {
    const content = await Deno.readTextFile(
      path.join(Deno.cwd(), CURRENT_TASK_FILE)
    );
    return parseYaml(content) as CurrentTask;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

/**
 * Clear the current task (task completed or abandoned).
 */
export async function clearCurrentTask(): Promise<void> {
  try {
    await Deno.remove(path.join(Deno.cwd(), CURRENT_TASK_FILE));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}
