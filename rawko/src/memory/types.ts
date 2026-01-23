/**
 * Memory types for rawko-sdk
 * See SPEC-0005, SPEC-0007, SPEC-0009 for details
 */

/**
 * Importance levels for memories
 */
export type MemoryImportance = "low" | "medium" | "high" | "critical";

/**
 * YAML frontmatter structure for memory files
 */
export interface MemoryFrontmatter {
  /** Unique, descriptive title */
  title: string;

  /** When this memory should be injected
   * Can be:
   * - Array of regex patterns: ["auth|login", "implement.*auth"]
   * - Description: "When task mentions authentication"
   * - Both: ["auth|login", "When implementing security features"]
   */
  whenToUse: string | string[];

  /** Categorical tags for organization */
  tags: string[];

  /** How important is this memory */
  importance: MemoryImportance;

  /** When was this discovered (ISO 8601) */
  discoveredAt: string;

  /** Which agent discovered this */
  discoveredBy: string;

  /** Which task led to this discovery */
  discoveredIn?: string;

  /** Optional source of discovery */
  source?: string;

  /** Optional related memory filenames */
  relatedMemories?: string[];
}

/**
 * Metadata loaded from memory file (frontmatter only)
 */
export interface MemoryMetadata {
  /** Full path to the memory file */
  path: string;
  /** Filename without path */
  filename: string;
  /** Parsed frontmatter */
  frontmatter: MemoryFrontmatter;
}

/**
 * Full memory file including content
 */
export interface MemoryFile extends MemoryMetadata {
  /** Markdown content (without frontmatter) */
  content: string;
}

/**
 * Input for memory extraction
 */
export interface MemoryExtractionInput {
  /** Which agent just executed */
  agent: string;
  /** The agent's task/prompt */
  task: string;
  /** The agent's output/response */
  agentOutput: string;
  /** Execution result */
  result: "success" | "failure" | "partial";
  /** Any error if failed */
  error?: string;
  /** Current memories for context */
  existingMemories: MemoryMetadata[];
}

/**
 * Output from memory extraction
 */
export interface MemoryExtractionOutput {
  /** Should we write a new memory? */
  shouldCreateMemory: boolean;
  /** Title for new memory (if creating) */
  memoryTitle?: string;
  /** Frontmatter for new memory */
  frontmatter?: MemoryFrontmatter;
  /** Content for new memory */
  content?: string;
  /** Reasoning for decision */
  reasoning: string;
}

/**
 * Context for finding relevant memories
 */
export interface MemoryMatchContext {
  /** Current task description */
  task: string;
  /** Current agent name */
  agentName: string;
  /** Agent display name */
  agentDisplayName?: string;
  /** Current plan (serialized) */
  currentPlan?: string;
  /** Recent history summary */
  recentHistory?: string;
}

/**
 * Options for finding relevant memories
 */
export interface FindMemoriesOptions {
  /** Maximum memories to return */
  maxMemories?: number;
  /** Minimum importance threshold */
  minImportance?: MemoryImportance;
}
