import path from "node:path";
import os from "node:os";

export type PathKind = "Source" | "User" | "System" | "Http";
export type FileRef =
  | { kind: "Source"; path?: string; relativePath?: string }
  | { kind: "User"; path: string }
  | { kind: "System"; path: string }
  | { kind: "Http"; url: string; integrity?: `sha256-${string}` };

const isUnder = (base: string, p: string) => {
  const rel = path.relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// NEW SIMPLE API - No boilerplate required!

export function source(relativePath: string): FileRef {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`source() requires relative path, got: ${relativePath}`);
  }
  return { kind: "Source", relativePath };
}

export function userPath(p: string): FileRef {
  const home = os.homedir();
  const rel = p.startsWith("~/") ? p.slice(2) : p;
  const abs = path.normalize(path.resolve(home, rel));
  if (!isUnder(home, abs)) throw new Error(`User path must be under HOME: ${p}`);
  return { kind: "User", path: abs };
}

export function userConfig(p: string): FileRef {
  return userPath(path.join(".config", p));
}

export function systemPath(p: string): FileRef {
  if (!path.isAbsolute(p)) throw new Error(`System path must be absolute: ${p}`);
  return { kind: "System", path: path.normalize(path.resolve(p)) };
}

export function http(url: string, opts?: { integrity?: `sha256-${string}` }): FileRef {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http/https");
  return { kind: "Http", url, integrity: opts?.integrity };
}

// DEPRECATED: Old API for backward compatibility
export function makePathFns(ctx: { moduleDir: string; home: string }) {
  const sourcePath = (p: string): FileRef => {
    if (path.isAbsolute(p)) throw new Error(`Source must be relative: ${p}`);
    const abs = path.normalize(path.resolve(ctx.moduleDir, p));
    if (!isUnder(ctx.moduleDir, abs)) throw new Error(`Source escapes moduleDir: ${p}`);
    return { kind: "Source", path: abs };
  };
  const _userPath = (p: string): FileRef => {
    const rel = p.startsWith("~/") ? p.slice(2) : p;
    const abs = path.normalize(path.resolve(ctx.home, rel));
    if (!isUnder(ctx.home, abs)) throw new Error(`User path must be under HOME: ${p}`);
    return { kind: "User", path: abs };
  };
  const userConfigPath = (p: string): FileRef => _userPath(path.join(".config", p));
  const _systemPath = (p: string): FileRef => {
    if (!path.isAbsolute(p)) throw new Error(`System path must be absolute: ${p}`);
    return { kind: "System", path: path.normalize(path.resolve(p)) };
  };
  const httpPath = (url: string, opts?: { integrity?: `sha256-${string}` }): FileRef => {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http/https");
    return { kind: "Http", url, integrity: opts?.integrity };
  };
  return { sourcePath, userPath: _userPath, userConfigPath, systemPath: _systemPath, httpPath };
}

// Internal: Resolve unresolved Source paths
export function resolveSourcePath(fileRef: FileRef, moduleDir: string): FileRef {
  if (fileRef.kind !== "Source") return fileRef;

  if (fileRef.relativePath) {
    const abs = path.normalize(path.resolve(moduleDir, fileRef.relativePath));
    if (!isUnder(moduleDir, abs)) {
      throw new Error(`Source path escapes module directory: ${fileRef.relativePath}`);
    }
    return { kind: "Source", path: abs };
  }

  return fileRef; // Already resolved
}
