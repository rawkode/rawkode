export type Ctx = {
  platform: "linux" | "darwin" | "win32"
  arch: string
  env: Record<string, string | undefined>
  home: string
  hasCmd(cmd: string): Promise<boolean>
  fileExists(p: string): Promise<boolean>
  readJson<T = unknown>(p: string): Promise<T>
}

export function makeCtx(): Ctx {
  return {
    platform: process.platform as Ctx["platform"],
    arch: process.arch,
    env: process.env,
    home: process.env.HOME!,
    hasCmd: async (cmd) => Bun.which(cmd) !== null,
    fileExists: async (p) => await Bun.file(p).exists(),
    readJson: async (p) => JSON.parse(await Bun.file(p).text()),
  }
}

export async function evalWhen(
  when: import("./schema").WhenPart | import("./schema").WhenPart[] | undefined,
  ctx: Ctx
): Promise<boolean> {
  if (!when) return true
  const parts = Array.isArray(when) ? when : [when]
  for (const p of parts) {
    const ok = typeof p === "function"
      ? await p(ctx)
      : !p.platformIn || p.platformIn.includes(ctx.platform)
    if (!ok) return false
  }
  return true
}
