import { Action, type ActionContext, type SideEffect } from "../action.ts";
import {
  archInstall,
  flatpakInstall,
  brewInstall,
  goInstall,
  cargoInstall,
  bunInstall,
  isArchPackageInstalled,
  isFlatpakInstalled,
  isBrewPackageInstalled,
  isGoPackageInstalled,
  isCargoPackageInstalled,
  isBunPackageInstalled,
} from "../../utils/package/mod.ts";

export type PackageManager =
  | "arch"
  | "bun"
  | "pacman"
  | "flatpak"
  | "brew"
  | "go"
  | "cargo";

export interface PackageConfig {
  manager: PackageManager;
  packages: string[];
  options?: Record<string, unknown>;
}

export class PackageInstallAction extends Action<PackageConfig> {
  async plan(context: ActionContext): Promise<SideEffect[]> {
    // Determine if this package manager requires elevation
    const requiresElevation = ["arch", "pacman", "flatpak"].includes(
      this.config.manager,
    );

    const effects: SideEffect[] = [];

    for (const pkg of this.config.packages) {
      let isInstalled = false;

      switch (this.config.manager) {
        case "arch":
        case "pacman":
          isInstalled = await isArchPackageInstalled(pkg);
          break;
        case "bun":
          isInstalled = await isBunPackageInstalled(pkg);
          break;
        case "flatpak":
          isInstalled = await isFlatpakInstalled(pkg);
          break;
        case "brew":
          isInstalled = await isBrewPackageInstalled(pkg);
          break;
        case "go":
          isInstalled = await isGoPackageInstalled(pkg);
          break;
        case "cargo":
          isInstalled = await isCargoPackageInstalled(pkg);
          break;
      }

      if (context.verbose) {
        console.log(
          `[${this.name}] Package ${pkg} (${this.config.manager}): ${isInstalled ? "already installed" : "needs installation"}`,
        );
      }

      if (!isInstalled) {
        effects.push({
          type: "package_install" as const,
          description: `Install ${pkg} via ${this.config.manager}`,
          target: pkg,
          metadata: {
            manager: this.config.manager,
            options: this.config.options,
          },
          requiresElevation,
        });
      }
    }

    return effects;
  }

  async apply(context: ActionContext): Promise<void> {
    if (context.dryRun) return;

    const options = {
      verbose: context.verbose,
      onOutput:
        context.eventEmitter && context.currentModule
          ? (data: string) =>
              context.eventEmitter!.emit(
                "moduleOutput",
                context.currentModule,
                data,
              )
          : undefined,
      onError:
        context.eventEmitter && context.currentModule
          ? (data: string) =>
              context.eventEmitter!.emit(
                "moduleOutput",
                context.currentModule,
                data,
              )
          : undefined,
    };

    switch (this.config.manager) {
      case "arch":
      case "pacman":
        await archInstall(this.config.packages, options);
        break;
      case "bun":
        await bunInstall(this.config.packages, options);
        break;
      case "flatpak":
        await flatpakInstall(this.config.packages, options);
        break;
      case "brew":
        await brewInstall(this.config.packages, options);
        break;
      case "go":
        for (const pkg of this.config.packages) {
          await goInstall(pkg, options);
        }
        break;
      case "cargo":
        for (const pkg of this.config.packages) {
          await cargoInstall(pkg, {
            ...((this.config.options as any) || {}),
            ...options,
          });
        }
        break;
      default:
        throw new Error(`Unknown package manager: ${this.config.manager}`);
    }
  }
}
