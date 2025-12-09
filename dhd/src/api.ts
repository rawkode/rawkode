import { z } from "zod";
import {
  Defaults,
  type DefaultsValueTypeT,
  Install,
  Launchd,
  LinkFile,
  LoginItem,
  ModuleStatic,
  type ModuleT,
  RunCommand,
} from "./schema.ts";
import type { FileRef } from "./paths.ts";

// Re-export path helpers so they're available when importing from api
export { http, source, systemPath, userConfig, userPath } from "./paths.ts";
export type { PathKind } from "./paths.ts";

export function install(
  pkg: string | string[],
  options?: {
    manager?: "brew" | "mas" | "pacman" | "apt" | "dnf" | "yay" | "nix";
    perManager?: Partial<Record<"brew" | "mas" | "pacman" | "apt" | "dnf" | "yay" | "nix", string>>;
  },
) {
  const list = Array.isArray(pkg) ? pkg : [pkg];
  return Install.parse({
    type: "install",
    manager: options?.manager,
    packages: list.map((name) => ({ default: name, ...options?.perManager })),
  });
}

export function linkFile(input: {
  source: FileRef;
  target: FileRef;
  force?: boolean;
  description?: string;
}) {
  return LinkFile.parse({ type: "linkFile", ...input });
}

export function runCommand(
  command: string,
  options?: { description?: string; sudo?: boolean },
) {
  return RunCommand.parse({
    type: "runCommand",
    command,
    description: options?.description,
    sudo: options?.sudo ?? false,
  });
}

export function defaults(
  domain: string,
  key: string,
  value: string | boolean | number | unknown[] | Record<string, unknown>,
  options?: {
    valueType?: DefaultsValueTypeT;
    host?: "currentHost";
    description?: string;
  },
) {
  return Defaults.parse({
    type: "defaults",
    domain,
    key,
    value,
    valueType: options?.valueType,
    host: options?.host,
    description: options?.description,
  });
}

export function launchd(
  action: "load" | "unload" | "enable" | "disable",
  target: { plistPath?: string; serviceName?: string },
  options?: { domain?: "user" | "system" | "gui"; description?: string },
) {
  return Launchd.parse({
    type: "launchd",
    action,
    plistPath: target.plistPath,
    serviceName: target.serviceName,
    domain: options?.domain ?? "user",
    description: options?.description,
  });
}

export function loginItem(
  action: "add" | "remove",
  app: string,
  options?: { hidden?: boolean; description?: string },
) {
  return LoginItem.parse({
    type: "loginItem",
    action,
    app,
    hidden: options?.hidden ?? false,
    description: options?.description,
  });
}

export function defineModule(
  base: z.input<typeof ModuleStatic> & {
    when?: import("./schema.ts").WhenPart | import("./schema.ts").WhenPart[];
  },
) {
  // Extract only ModuleStatic fields for parsing (exclude 'when')
  const { name, tags, dependsOn } = base;
  const stat = ModuleStatic.parse({ name, tags, dependsOn });
  return {
    actions(list: unknown[]): ModuleT {
      // validate individual actions via discriminators
      const parsed = list.map((a) => {
        if (typeof a !== "object" || !a) throw new Error("Invalid action");
        // Already parsed by builders; trust here for POC
        return a as any;
      });
      return { ...stat, when: base.when, actions: parsed };
    },
  };
}
