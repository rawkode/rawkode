/**
 * High-level helpers for common configuration tasks
 * These handle OS-specific logic automatically
 */

import { defineModule, linkFile, runCommand, source, userConfig } from "./api.ts";
import type { ActionT } from "./schema.ts";

// ============================================================================
// USER CONFIGURATION
// ============================================================================

interface UserOptions {
  shell?: string;
}

/**
 * Configure user settings like default shell
 *
 * Handles OS-specific commands automatically:
 * - macOS: Uses dscl (Directory Services)
 * - Linux: Uses chsh
 *
 * @example
 * ```typescript
 * import { user } from "@rawkode/dhd"
 *
 * export default user({ shell: "fish" })
 * export default user({ shell: "zsh" })
 * ```
 */
export function user(options: UserOptions = {}) {
  const { shell = "fish" } = options;
  const actions: ActionT[] = [];

  // macOS-specific actions
  if (process.platform === "darwin") {
    actions.push(
      runCommand(
        `SHELL_PATH=$(which ${shell}); grep -qxF "$SHELL_PATH" /etc/shells || echo "$SHELL_PATH" | tee -a /etc/shells`,
        {
          description: `Add ${shell} to /etc/shells if not present`,
          sudo: true,
        },
      ),
      runCommand(
        `dscl . -create /Users/$USER UserShell $(which ${shell})`,
        {
          description: `Set ${shell} as default shell via Directory Services`,
          sudo: true,
        },
      ),
    );
  }

  // Linux-specific actions
  if (process.platform === "linux") {
    actions.push(
      runCommand(
        `SHELL_PATH=$(which ${shell}); grep -qxF "$SHELL_PATH" /etc/shells || echo "$SHELL_PATH" | tee -a /etc/shells`,
        {
          description: `Add ${shell} to /etc/shells if not present`,
          sudo: true,
        },
      ),
      runCommand(
        `chsh -s $(which ${shell})`,
        {
          description: `Set ${shell} as default shell`,
        },
      ),
    );
  }

  return defineModule({
    name: "user",
    tags: ["user", "shell"],
    dependsOn: [shell],
  }).actions(actions);
}

// ============================================================================
// SHELL INTEGRATION
// ============================================================================

interface ShellIntegrationOptions {
  /** The tool name (used for description and file naming) */
  tool: string;
  /** Fish shell integration file (relative to module directory) */
  fish?: string;
  /** Nushell integration file (relative to module directory) */
  nushell?: string;
  /** Bash integration file (relative to module directory) */
  bash?: string;
  /** Zsh integration file (relative to module directory) */
  zsh?: string;
}

/**
 * Create shell integration actions for linking init files to shell conf.d directories
 *
 * Automatically places files in the correct locations for each shell to auto-load:
 * - Fish: ~/.config/fish/conf.d/
 * - Nushell: ~/.config/nushell/conf.d/
 * - Bash: ~/.bashrc.d/
 * - Zsh: ~/.zshrc.d/
 *
 * @example
 * ```typescript
 * import { defineModule, install, shellIntegration } from "@rawkode/dhd"
 *
 * export default defineModule({
 *   name: "zoxide",
 *   tags: ["shell", "navigation"],
 * }).actions([
 *   install("zoxide"),
 *   ...shellIntegration({
 *     tool: "zoxide",
 *     fish: "init.fish",
 *     nushell: "init.nu",
 *   }),
 * ])
 * ```
 */
export function shellIntegration(options: ShellIntegrationOptions): ActionT[] {
  const { tool, fish, nushell, bash, zsh } = options;
  const actions: ActionT[] = [];

  if (fish) {
    actions.push(
      linkFile({
        source: source(fish),
        target: userConfig(`fish/conf.d/${tool}.fish`),
        force: true,
        description: `Link ${tool} Fish shell integration`,
      }),
    );
  }

  if (nushell) {
    actions.push(
      linkFile({
        source: source(nushell),
        target: userConfig(`nushell/conf.d/${tool}.nu`),
        force: true,
        description: `Link ${tool} Nushell integration`,
      }),
    );
  }

  if (bash) {
    actions.push(
      linkFile({
        source: source(bash),
        target: userConfig(`bashrc.d/${tool}.sh`),
        force: true,
        description: `Link ${tool} Bash integration`,
      }),
    );
  }

  if (zsh) {
    actions.push(
      linkFile({
        source: source(zsh),
        target: userConfig(`zshrc.d/${tool}.zsh`),
        force: true,
        description: `Link ${tool} Zsh integration`,
      }),
    );
  }

  return actions;
}
