import { Module, type ModuleLoader, type ModuleDefinition } from "../module.ts";
import path from "node:path";

export interface StandaloneModuleRegistry {
  [relativePath: string]: ModuleDefinition;
}

export interface ModulePathInfo {
  relative: string;
  absolute: string;
  directory: string;
}

export class StandaloneModuleLoader implements ModuleLoader {
  private basePath: string;
  private registry: StandaloneModuleRegistry;
  private modulePaths: string[];
  private absolutePaths?: ModulePathInfo[];
  private pathMap: Map<string, string> = new Map();

  constructor(
    basePath: string, 
    registry: StandaloneModuleRegistry, 
    modulePaths: string[], 
    absolutePaths?: ModulePathInfo[]
  ) {
    this.basePath = basePath;
    this.registry = registry;
    this.modulePaths = modulePaths;
    this.absolutePaths = absolutePaths;
    
    // Build a map from relative paths to absolute directories
    if (absolutePaths) {
      for (const pathInfo of absolutePaths) {
        this.pathMap.set(pathInfo.relative, pathInfo.directory);
      }
    }
  }

  async load(modulePath: string): Promise<Module> {
    // Convert absolute path to relative path matching our registry
    const relativePath = path.relative(this.basePath, modulePath);
    const moduleDefinition = this.registry[relativePath];

    if (!moduleDefinition) {
      throw new Error(`Module not found in registry: ${relativePath}`);
    }

    if (!moduleDefinition.metadata || !moduleDefinition.metadata.name) {
      throw new Error(`Module ${relativePath} must have metadata with a name`);
    }

    // Use the original filesystem directory if available
    const originalDirectory = this.pathMap.get(relativePath);
    if (originalDirectory) {
      // Create a custom module that overrides the directory property
      return new StandaloneModule(modulePath, moduleDefinition, originalDirectory);
    }

    return new Module(modulePath, moduleDefinition);
  }

  async discover(basePath: string): Promise<Module[]> {
    const modules: Module[] = [];

    for (const modulePath of this.modulePaths) {
      const fullPath = path.join(basePath, modulePath);
      try {
        const module = await this.load(fullPath);
        modules.push(module);
      } catch (error) {
        console.warn(`Failed to load module ${modulePath}:`, error);
      }
    }

    return modules;
  }
}

// Custom module class that can override the directory
class StandaloneModule extends Module {
  private _directory: string;

  constructor(path: string, definition: ModuleDefinition, directory: string) {
    super(path, definition);
    this._directory = directory;
  }

  get directory(): string {
    return this._directory;
  }
}