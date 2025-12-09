// @ts-types="npm:@types/which@^3"
import which from "which";

export type Ctx = {
  platform: "linux" | "darwin" | "win32";
  arch: string;
  env: Record<string, string | undefined>;
  home: string;
  hasCmd(cmd: string): Promise<boolean>;
  fileExists(p: string): Promise<boolean>;
  readJson<T = unknown>(p: string): Promise<T>;
};

export function makeCtx(): Ctx {
  return {
    platform: process.platform as Ctx["platform"],
    arch: process.arch,
    env: process.env,
    home: process.env.HOME!,
    hasCmd: async (cmd) => {
      try {
        await which(cmd);
        return true;
      } catch {
        return false;
      }
    },
    fileExists: async (p) => {
      try {
        await Deno.stat(p);
        return true;
      } catch {
        return false;
      }
    },
    readJson: async (p) => JSON.parse(await Deno.readTextFile(p)),
  };
}

export async function evalWhen(
  when: import("./schema.ts").WhenPart | import("./schema.ts").WhenPart[] | undefined,
  ctx: Ctx,
): Promise<boolean> {
  if (!when) return true;
  const parts = Array.isArray(when) ? when : [when];
  for (const p of parts) {
    const ok = typeof p === "function"
      ? await p(ctx)
      : !p.platformIn || p.platformIn.includes(ctx.platform);
    if (!ok) return false;
  }
  return true;
}
