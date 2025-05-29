#!/usr/bin/env bun
import { glob } from "glob";
import path from "node:path";
import fs from "node:fs";

export interface GenerateRegistryOptions {
  // The base directory to search for modules
  baseDir?: string;
  // The glob pattern to match module files (default: "**/mod.ts")
  pattern?: string;
  // Patterns to ignore (default: ["node_modules/**", "dist/**", "build/**"])
  ignore?: string[];
  // The output file path (default: "module-registry.ts")
  outputPath?: string;
  // Whether to use relative imports (default: true)
  useRelativeImports?: boolean;
}

export async function generateModuleRegistry(options: GenerateRegistryOptions = {}) {
  const {
    baseDir = process.cwd(),
    pattern = "**/mod.ts",
    ignore = ["node_modules/**", "dist/**", "build/**"],
    outputPath = "module-registry.ts",
    useRelativeImports = true,
  } = options;

  // Find all module files
  const moduleFiles = await glob(pattern, {
    cwd: baseDir,
    ignore,
  });

  // Generate imports for all modules
  const imports = moduleFiles.map((file, index) => {
    const modulePath = useRelativeImports ? "./" + file : path.join(baseDir, file);
    return `import module${index} from "${modulePath}";`;
  }).join("\n");

  // Generate module map
  const moduleMap = moduleFiles.map((file, index) => {
    return `  "${file}": module${index},`;
  }).join("\n");

  // Generate module paths with absolute paths
  const absoluteModulePaths = moduleFiles.map(file => ({
    relative: file,
    absolute: path.join(baseDir, file),
    directory: path.join(baseDir, path.dirname(file))
  }));

  // Generate the registry file
  const registryContent = `// Auto-generated module registry
${imports}

export const MODULE_REGISTRY = {
${moduleMap}
};

export const MODULE_PATHS = ${JSON.stringify(moduleFiles, null, 2)};

export const MODULE_ABSOLUTE_PATHS = ${JSON.stringify(absoluteModulePaths, null, 2)};
`;

  const fullOutputPath = path.isAbsolute(outputPath) 
    ? outputPath 
    : path.join(baseDir, outputPath);
    
  await fs.promises.writeFile(fullOutputPath, registryContent);
  console.log(`✅ Generated module registry with ${moduleFiles.length} modules at ${fullOutputPath}`);
  
  return {
    moduleCount: moduleFiles.length,
    outputPath: fullOutputPath,
    modules: moduleFiles,
  };
}

// CLI support when run directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  const baseDir = args[0] || process.cwd();
  
  generateModuleRegistry({ baseDir }).catch((error) => {
    console.error("❌ Failed to generate module registry:", error);
    process.exit(1);
  });
}