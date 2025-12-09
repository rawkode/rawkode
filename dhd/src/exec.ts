import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";

// Services that need restart after defaults write
const RESTART_SERVICES: Record<string, string> = {
  "com.apple.dock": "killall Dock",
  "com.apple.finder": "killall Finder",
  "com.apple.systemuiserver": "killall SystemUIServer",
};

async function readDefaultsValue(
  domain: string,
  key: string,
  host?: "currentHost",
): Promise<unknown> {
  const hostFlag = host === "currentHost" ? "-currentHost " : "";
  const domainArg = domain === "NSGlobalDomain" ? "-g" : `"${domain}"`;
  const cmd = `defaults ${hostFlag}read ${domainArg} "${key}" 2>/dev/null`;

  const command = new Deno.Command("/bin/sh", {
    args: ["-c", cmd],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout } = await command.output();
  if (code !== 0) return undefined;

  const output = new TextDecoder().decode(stdout);
  return parseDefaultsOutput(output.trim());
}

function parseDefaultsOutput(output: string): unknown {
  if (output === "1" || output === "true") return true;
  if (output === "0" || output === "false") return false;
  const num = Number(output);
  if (!isNaN(num) && output !== "") return num;
  return output;
}

function valuesEqual(current: unknown, desired: unknown, valueType: string): boolean {
  if (current === undefined) return false;
  if (valueType === "bool") {
    const currentBool = current === true || current === 1 || current === "1" || current === "true";
    const desiredBool = desired === true || desired === 1 || desired === "1" || desired === "true";
    return currentBool === desiredBool;
  }
  if (valueType === "array" || valueType === "dict") {
    return JSON.stringify(current) === JSON.stringify(desired);
  }
  return String(current) === String(desired);
}

function buildDefaultsWriteCmd(
  op: { domain: string; key: string; value: unknown; valueType: string; host?: "currentHost" },
): string {
  const hostFlag = op.host === "currentHost" ? "-currentHost " : "";
  const domainArg = op.domain === "NSGlobalDomain" ? "-g" : `"${op.domain}"`;

  let valueArg: string;
  switch (op.valueType) {
    case "bool":
      valueArg = `-bool ${op.value ? "true" : "false"}`;
      break;
    case "int":
      valueArg = `-int ${op.value}`;
      break;
    case "float":
      valueArg = `-float ${op.value}`;
      break;
    case "array":
      valueArg = `-array ${(op.value as unknown[]).map((v) => `"${v}"`).join(" ")}`;
      break;
    case "array-add":
      valueArg = `-array-add ${(op.value as unknown[]).map((v) => `"${v}"`).join(" ")}`;
      break;
    case "dict": {
      const pairs = Object.entries(op.value as Record<string, unknown>)
        .map(([k, v]) => `"${k}" "${v}"`)
        .join(" ");
      valueArg = `-dict ${pairs}`;
      break;
    }
    case "dict-add": {
      const pairs = Object.entries(op.value as Record<string, unknown>)
        .map(([k, v]) => `"${k}" "${v}"`)
        .join(" ");
      valueArg = `-dict-add ${pairs}`;
      break;
    }
    case "data":
      valueArg = `-data "${op.value}"`;
      break;
    default:
      valueArg = `-string "${op.value}"`;
  }

  return `defaults ${hostFlag}write ${domainArg} "${op.key}" ${valueArg}`;
}

async function restartServiceIfNeeded(domain: string): Promise<void> {
  const cmd = RESTART_SERVICES[domain];
  if (cmd) {
    const command = new Deno.Command("/bin/sh", {
      args: ["-c", cmd],
      stdout: "piped",
      stderr: "piped",
    });
    await command.output();
  }
}

async function isServiceLoaded(identifier: string): Promise<boolean> {
  const command = new Deno.Command("launchctl", {
    args: ["list"],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout } = await command.output();
  const output = new TextDecoder().decode(stdout);
  return output.includes(identifier);
}

async function getLoginItems(): Promise<string[]> {
  const script = `tell application "System Events" to get the name of every login item`;
  const command = new Deno.Command("osascript", {
    args: ["-e", script],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await command.output();
  if (code !== 0) return [];
  const output = new TextDecoder().decode(stdout);
  return output.trim().split(", ").filter(Boolean);
}

export async function execOp(op: import("./plan.ts").PlanOp) {
  if (op.op === "install") {
    // Check mas authentication before installing
    if (op.manager === "mas") {
      const authCheck = new Deno.Command("mas", {
        args: ["account"],
        stdout: "piped",
        stderr: "piped",
      });
      const { code } = await authCheck.output();
      if (code !== 0) {
        throw new Error(
          "Not signed into Mac App Store. Please run 'mas signin' or sign in via the App Store app.",
        );
      }
    }

    const cmd = {
      brew: ["brew", ["install", op.pkg]],
      pacman: ["sudo", ["pacman", "-S", "--noconfirm", op.pkg]],
      apt: ["sudo", ["apt-get", "install", "-y", op.pkg]],
      dnf: ["sudo", ["dnf", "install", "-y", op.pkg]],
      yay: ["yay", ["-S", "--noconfirm", op.pkg]],
      nix: ["nix-env", ["-iA", op.pkg]],
      mas: ["mas", ["install", op.pkg]],
    }[op.manager] as [string, string[]];
    const command = new Deno.Command(cmd[0], {
      args: cmd[1],
      stdout: "inherit",
      stderr: "inherit",
    });
    const { code } = await command.output();
    if (code !== 0) throw new Error(`install failed: ${op.manager} ${op.pkg}`);
    return;
  }
  if (op.op === "download") {
    await mkdir(path.dirname(op.dest), { recursive: true });
    const res = await fetch(op.url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (op.integrity) {
      const [, hex] = op.integrity.split("sha256-");
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const got = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (got !== hex.toLowerCase()) throw new Error(`integrity mismatch`);
    }
    await Deno.writeFile(op.dest, buf);
    return;
  }
  if (op.op === "link") {
    await mkdir(path.dirname(op.dst), { recursive: true });
    if (op.overwrite) await rm(op.dst, { force: true });
    await symlink(op.src, op.dst);
    return;
  }
  if (op.op === "runCommand") {
    const cmd = op.sudo ? ["sudo", "/bin/sh", "-c", op.command] : ["/bin/sh", "-c", op.command];

    const command = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "inherit",
      stderr: "inherit",
    });
    const { code } = await command.output();
    if (code !== 0) throw new Error(`command failed: ${op.command}`);
    return;
  }

  if (op.op === "defaults") {
    if (process.platform !== "darwin") {
      console.log(`[skip] defaults: ${op.domain} ${op.key} (not macOS)`);
      return;
    }

    const currentValue = await readDefaultsValue(op.domain, op.key, op.host);
    if (valuesEqual(currentValue, op.value, op.valueType)) {
      console.log(`[skip] defaults: ${op.domain} ${op.key} (already set)`);
      return;
    }

    const cmd = buildDefaultsWriteCmd(op);
    const command = new Deno.Command("/bin/sh", {
      args: ["-c", cmd],
      stdout: "inherit",
      stderr: "inherit",
    });
    const { code } = await command.output();
    if (code !== 0) {
      console.warn(`[warn] defaults write failed: ${op.domain} ${op.key}`);
      return;
    }

    console.log(`[ok] defaults: ${op.domain} ${op.key}`);
    await restartServiceIfNeeded(op.domain);
    return;
  }

  if (op.op === "launchd") {
    if (process.platform !== "darwin") {
      console.log(`[skip] launchd: (not macOS)`);
      return;
    }

    const identifier = op.serviceName || op.plistPath || "";
    const isLoaded = await isServiceLoaded(identifier);

    if ((op.action === "load" || op.action === "enable") && isLoaded) {
      console.log(`[skip] launchd ${op.action}: ${identifier} (already loaded)`);
      return;
    }
    if ((op.action === "unload" || op.action === "disable") && !isLoaded) {
      console.log(
        `[skip] launchd ${op.action}: ${identifier} (already unloaded)`,
      );
      return;
    }

    const uid = process.getuid?.() ?? 501;
    let cmd: string;
    switch (op.action) {
      case "load":
        cmd = `launchctl load "${op.plistPath}"`;
        break;
      case "unload":
        cmd = `launchctl unload "${op.plistPath}"`;
        break;
      case "enable": {
        const domain = op.domain === "system" ? "system" : `gui/${uid}`;
        cmd = `launchctl enable ${domain}/${op.serviceName}`;
        break;
      }
      case "disable": {
        const domain = op.domain === "system" ? "system" : `gui/${uid}`;
        cmd = `launchctl disable ${domain}/${op.serviceName}`;
        break;
      }
    }

    const command = new Deno.Command("/bin/sh", {
      args: ["-c", cmd],
      stdout: "inherit",
      stderr: "inherit",
    });
    const { code } = await command.output();
    if (code !== 0) {
      console.warn(`[warn] launchd ${op.action} failed: ${identifier}`);
      return;
    }

    console.log(`[ok] launchd ${op.action}: ${identifier}`);
    return;
  }

  if (op.op === "loginItem") {
    if (process.platform !== "darwin") {
      console.log(`[skip] loginItem: (not macOS)`);
      return;
    }

    const existingItems = await getLoginItems();
    const exists = existingItems.some((item) => item.includes(op.app));

    if (op.action === "add" && exists) {
      console.log(`[skip] loginItem add: ${op.app} (already exists)`);
      return;
    }
    if (op.action === "remove" && !exists) {
      console.log(`[skip] loginItem remove: ${op.app} (not found)`);
      return;
    }

    let script: string;
    if (op.action === "add") {
      script =
        `tell application "System Events" to make login item at end with properties {path:"/Applications/${op.app}.app", hidden:${op.hidden}}`;
    } else {
      script = `tell application "System Events" to delete login item "${op.app}"`;
    }

    const command = new Deno.Command("osascript", {
      args: ["-e", script],
      stdout: "inherit",
      stderr: "inherit",
    });
    const { code } = await command.output();
    if (code !== 0) {
      console.warn(`[warn] loginItem ${op.action} failed: ${op.app}`);
      return;
    }

    console.log(`[ok] loginItem ${op.action}: ${op.app}`);
    return;
  }
}
