import type { ActionT } from "./schema.ts";
import { resolveSourcePath } from "./paths.ts";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";

export type PlanOp =
  | {
    op: "install";
    manager: "brew" | "mas" | "pacman" | "apt" | "dnf" | "yay" | "nix";
    pkg: string;
  }
  | { op: "download"; url: string; dest: string; integrity?: `sha256-${string}` }
  | { op: "link"; src: string; dst: string; overwrite: boolean }
  | { op: "runCommand"; command: string; description?: string; sudo: boolean }
  | {
    op: "defaults";
    domain: string;
    key: string;
    value: unknown;
    valueType: string;
    host?: "currentHost";
    description?: string;
  }
  | {
    op: "launchd";
    action: "load" | "unload" | "enable" | "disable";
    plistPath?: string;
    serviceName?: string;
    domain: "user" | "system" | "gui";
    description?: string;
  }
  | {
    op: "loginItem";
    action: "add" | "remove";
    app: string;
    hidden: boolean;
    description?: string;
  };

const CACHE = path.join(os.homedir(), ".cache", "dotfiles", "http");

function resolvePkg(p: any, mgr: string) {
  return p[mgr] ?? p.default;
}

function inferValueType(value: unknown): string {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value !== null) return "dict";
  return "string";
}

export function plan(
  actions: ActionT[],
  mgr: "brew" | "mas" | "pacman" | "apt" | "dnf" | "yay" | "nix",
  moduleDir?: string,
): PlanOp[] {
  const ops: PlanOp[] = [];
  for (const a of actions) {
    if (a.type === "install") {
      // Use explicit manager if specified, otherwise use detected manager
      const manager = a.manager ?? mgr;
      for (const p of a.packages) ops.push({ op: "install", manager, pkg: resolvePkg(p, manager) });
    } else if (a.type === "linkFile") {
      // Resolve Source paths if we have a moduleDir
      let source = a.source;
      if (source.kind === "Source" && moduleDir) {
        source = resolveSourcePath(source, moduleDir);
      }

      if (source.kind === "Http") {
        const key = crypto.createHash("sha256").update(source.url).digest("hex").slice(0, 16);
        const dest = path.join(CACHE, key);
        ops.push({
          op: "download",
          url: source.url,
          dest,
          integrity: source.integrity as `sha256-${string}` | undefined,
        });
        ops.push({ op: "link", src: dest, dst: a.target.path, overwrite: a.force });
      } else {
        if (!source.path) {
          throw new Error(`Source path not resolved for ${JSON.stringify(source)}`);
        }
        ops.push({ op: "link", src: source.path, dst: a.target.path, overwrite: a.force });
      }
    } else if (a.type === "runCommand") {
      ops.push({ op: "runCommand", command: a.command, description: a.description, sudo: a.sudo });
    } else if (a.type === "defaults") {
      const valueType = a.valueType ?? inferValueType(a.value);
      ops.push({
        op: "defaults",
        domain: a.domain,
        key: a.key,
        value: a.value,
        valueType,
        host: a.host,
        description: a.description,
      });
    } else if (a.type === "launchd") {
      ops.push({
        op: "launchd",
        action: a.action,
        plistPath: a.plistPath,
        serviceName: a.serviceName,
        domain: a.domain,
        description: a.description,
      });
    } else if (a.type === "loginItem") {
      ops.push({
        op: "loginItem",
        action: a.action,
        app: a.app,
        hidden: a.hidden,
        description: a.description,
      });
    }
  }
  return ops;
}
