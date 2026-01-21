import { join, basename } from "path";
import matter from "gray-matter";
import {
  PhaseFrontmatterSchema,
  PhaseConfigSchema,
  type PhaseConfig,
  type PhaseGraph,
  PhaseConfigError,
  PhaseGraphError,
  NoPhaseConfiguredError,
} from "./schema.ts";

const PHASES_DIR = ".rocko/phases";

/**
 * Extract system prompt and user prompt template from markdown body
 */
function extractPrompts(markdownBody: string): {
  systemPrompt?: string;
  userPromptTemplate?: string;
} {
  const result: { systemPrompt?: string; userPromptTemplate?: string } = {};

  // Split by ## headers
  const sections = markdownBody.split(/^## /m);

  for (const section of sections) {
    const lines = section.trim().split("\n");
    const header = lines[0]?.toLowerCase().trim();
    const content = lines.slice(1).join("\n").trim();

    if (header === "system prompt") {
      result.systemPrompt = content;
    } else if (header === "user prompt template") {
      result.userPromptTemplate = content;
    }
  }

  return result;
}

/**
 * Get phase ID from filename (e.g., "01-plan.md" -> "plan")
 */
function getPhaseIdFromFilename(filename: string): string {
  // Remove .md extension
  const base = basename(filename, ".md");
  // Remove leading numbers and dashes (e.g., "01-plan" -> "plan")
  const withoutPrefix = base.replace(/^\d+-/, "");
  return withoutPrefix;
}

/**
 * Load a single phase from a markdown file
 */
export async function loadPhaseFile(filePath: string): Promise<PhaseConfig> {
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    throw new PhaseConfigError("Phase file not found", filePath);
  }

  const content = await file.text();
  const { data: frontmatter, content: markdownBody } = matter(content);

  // Parse frontmatter
  const parsedFrontmatter = PhaseFrontmatterSchema.safeParse(frontmatter);

  if (!parsedFrontmatter.success) {
    throw new PhaseConfigError(
      "Invalid phase frontmatter",
      filePath,
      parsedFrontmatter.error.format()
    );
  }

  // Derive ID from filename if not specified
  const id = parsedFrontmatter.data.id ?? getPhaseIdFromFilename(filePath);

  // Extract prompts from markdown body
  const prompts = extractPrompts(markdownBody);

  // Build full config
  const config: PhaseConfig = {
    ...parsedFrontmatter.data,
    id,
    ...prompts,
    filePath,
  };

  // Validate full config
  const validatedConfig = PhaseConfigSchema.safeParse(config);

  if (!validatedConfig.success) {
    throw new PhaseConfigError(
      "Invalid phase configuration",
      filePath,
      validatedConfig.error.format()
    );
  }

  return validatedConfig.data;
}

/**
 * Load all phases from the phases directory
 */
export async function loadPhases(rootDir: string = process.cwd()): Promise<PhaseGraph> {
  const phasesDir = join(rootDir, PHASES_DIR);

  // Check if phases directory exists
  const dir = Bun.file(phasesDir);
  const dirInfo = await Bun.$`ls -la ${phasesDir} 2>/dev/null || true`.quiet().text();

  if (!dirInfo.trim()) {
    throw new NoPhaseConfiguredError();
  }

  // Find all .md files in the phases directory
  const glob = new Bun.Glob("*.md");
  const files: string[] = [];

  for await (const file of glob.scan({ cwd: phasesDir, absolute: false })) {
    files.push(file);
  }

  if (files.length === 0) {
    throw new NoPhaseConfiguredError();
  }

  // Sort files to ensure consistent ordering (by filename)
  files.sort();

  // Load all phase files
  const phases = new Map<string, PhaseConfig>();

  for (const file of files) {
    const filePath = join(phasesDir, file);
    const config = await loadPhaseFile(filePath);

    if (phases.has(config.id)) {
      throw new PhaseGraphError(
        `Duplicate phase ID: ${config.id} (found in ${config.filePath} and ${phases.get(config.id)?.filePath})`
      );
    }

    phases.set(config.id, config);
  }

  // Validate the phase graph
  return validatePhaseGraph(phases);
}

/**
 * Validate the loaded phases form a valid state machine graph
 */
function validatePhaseGraph(phases: Map<string, PhaseConfig>): PhaseGraph {
  const phaseIds = new Set(phases.keys());

  // Find initial phase(s)
  const initialPhases = Array.from(phases.values()).filter((p) => p.initial);

  if (initialPhases.length === 0) {
    throw new PhaseGraphError(
      "No initial phase defined. Mark one phase with 'initial: true' in frontmatter."
    );
  }

  if (initialPhases.length > 1) {
    throw new PhaseGraphError(
      `Multiple initial phases defined: ${initialPhases.map((p) => p.id).join(", ")}. Only one phase can be initial.`
    );
  }

  // Find final phase(s)
  const finalPhases = Array.from(phases.values()).filter((p) => p.final);

  if (finalPhases.length === 0) {
    throw new PhaseGraphError(
      "No final phase defined. Mark at least one phase with 'final: true' in frontmatter."
    );
  }

  // Validate all transition targets exist
  for (const phase of phases.values()) {
    for (const transition of phase.transitions) {
      if (!phaseIds.has(transition.target)) {
        throw new PhaseGraphError(
          `Invalid transition target '${transition.target}' in phase '${phase.id}' (${phase.filePath}). ` +
          `Available phases: ${Array.from(phaseIds).join(", ")}`
        );
      }
    }
  }

  // Validate non-final phases have transitions (unless they're final)
  for (const phase of phases.values()) {
    if (!phase.final && phase.transitions.length === 0) {
      throw new PhaseGraphError(
        `Phase '${phase.id}' has no transitions and is not marked as final. ` +
        `Either add transitions or mark it as 'final: true'.`
      );
    }
  }

  return {
    phases,
    initialPhaseId: initialPhases[0]!.id,
    finalPhaseIds: finalPhases.map((p) => p.id),
  };
}

/**
 * Check if phases are configured
 */
export async function phasesExist(rootDir: string = process.cwd()): Promise<boolean> {
  const phasesDir = join(rootDir, PHASES_DIR);

  try {
    const glob = new Bun.Glob("*.md");
    for await (const _ of glob.scan({ cwd: phasesDir, absolute: false })) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Get the phases directory path
 */
export function getPhasesDir(rootDir: string = process.cwd()): string {
  return join(rootDir, PHASES_DIR);
}
