# DHD Build Tools

The DHD build tools help you create standalone CLI applications from your DHD-based configuration modules.

## Overview

These tools allow you to:
- Generate a module registry for bundling
- Create standalone executables that don't require runtime module discovery
- Build custom CLI tools based on DHD

## Usage

### 1. Generate Module Registry

Create a build script (`build.ts`):

```typescript
#!/usr/bin/env bun
import { generateModuleRegistry } from "@rawkode/dhd/core/build";

await generateModuleRegistry({
  baseDir: import.meta.dir,
  pattern: "**/mod.ts",
  ignore: ["node_modules/**", "dist/**", "build/**"],
  outputPath: "module-registry.ts",
});
```

### 2. Create CLI Application

Create your CLI (`cli.ts`):

```typescript
#!/usr/bin/env bun
import { createStandaloneCLI } from "@rawkode/dhd/core/build";
import { MODULE_REGISTRY, MODULE_PATHS } from "./module-registry.ts";

createStandaloneCLI(MODULE_REGISTRY, MODULE_PATHS, {
  name: "myapp",
  description: "My DHD-based configuration manager",
  version: "1.0.0",
});
```

### 3. Build Standalone Binary

Add to your `package.json`:

```json
{
  "scripts": {
    "build:registry": "bun run build.ts",
    "build": "bun run build.ts && bun build cli.ts --compile --outfile myapp",
    "build:dev": "bun build cli.ts --compile --outfile myapp-dev"
  }
}
```

Then build:

```bash
bun run build
```

## API Reference

### generateModuleRegistry(options)

Generates a module registry file for bundling.

Options:
- `baseDir` - Base directory to search (default: current directory)
- `pattern` - Glob pattern for modules (default: "**/mod.ts")
- `ignore` - Patterns to ignore (default: ["node_modules/**", "dist/**", "build/**"])
- `outputPath` - Output file path (default: "module-registry.ts")
- `useRelativeImports` - Use relative imports (default: true)

### createStandaloneCLI(registry, paths, options)

Creates a standalone CLI application.

Options:
- `name` - CLI tool name (required)
- `description` - CLI description
- `version` - CLI version
- `helpText` - Custom help text
- `moduleFilter` - Custom module filter function
- `registerActions` - Register core actions (default: true)
- `additionalCommands` - Add custom commands

## Example

See the [rawkOS](../../../rawkOS) project for a complete example of using these build tools.