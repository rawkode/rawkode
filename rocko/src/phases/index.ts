// Phase configuration schema and types
export * from "./schema.ts";

// Phase loader
export { loadPhases, loadPhaseFile, phasesExist, getPhasesDir } from "./loader.ts";

// Machine generator
export {
  generateMachineConfig,
  createDynamicMachine,
  buildEventData,
  type DynamicMachineContext,
  type DynamicMachineEvent,
  type DynamicMachine,
} from "./generator.ts";

// Phase executor
export {
  executePhase,
  applyAssignments,
  buildExecutionContext,
  cleanupExecutors,
  type ExecutePhaseOptions,
} from "./executor.ts";

// Default phases
export { createDefaultPhases, getDefaultPhaseFilenames, DEFAULT_PHASES } from "./defaults.ts";
