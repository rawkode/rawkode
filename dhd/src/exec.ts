import { mkdir, symlink, rm } from "node:fs/promises"
import path from "node:path"

export async function execOp(op: import("./plan").PlanOp) {
  if (op.op === "install") {
    const cmd = {
      brew: ["brew", ["install", op.pkg]],
      pacman: ["sudo", ["pacman", "-S", "--noconfirm", op.pkg]],
      apt: ["sudo", ["apt-get", "install", "-y", op.pkg]],
      dnf: ["sudo", ["dnf", "install", "-y", op.pkg]],
      yay: ["yay", ["-S", "--noconfirm", op.pkg]],
      nix: ["nix-env", ["-iA", op.pkg]],
    }[op.manager] as [string, string[]]
    const proc = Bun.spawn({ cmd: [cmd[0], ...cmd[1]], stdout: "inherit", stderr: "inherit" })
    const code = await proc.exited
    if (code !== 0) throw new Error(`install failed: ${op.manager} ${op.pkg}`)
    return
  }
  if (op.op === "download") {
    await mkdir(path.dirname(op.dest), { recursive: true })
    const res = await fetch(op.url)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (op.integrity) {
      const [, hex] = op.integrity.split("sha256-")
      const digest = await crypto.subtle.digest("SHA-256", buf)
      const got = Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("")
      if (got !== hex.toLowerCase()) throw new Error(`integrity mismatch`)
    }
    await Bun.write(op.dest, buf)
    return
  }
  if (op.op === "link") {
    await mkdir(path.dirname(op.dst), { recursive: true })
    if (op.overwrite) await rm(op.dst, { force: true })
    await symlink(op.src, op.dst)
    return
  }
  if (op.op === "runCommand") {
    const cmd = op.sudo
      ? ["sudo", "/bin/sh", "-c", op.command]
      : ["/bin/sh", "-c", op.command]

    const proc = Bun.spawn({
      cmd,
      stdout: "inherit",
      stderr: "inherit"
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`command failed: ${op.command}`)
    return
  }
}
