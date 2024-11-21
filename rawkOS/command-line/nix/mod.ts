import { runCommand, runPrivilegedCommand } from "../../utils/commands/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";

ensureHomeSymlink(
  `${import.meta.dirname}/nix.fish`,
  ".config/fish/conf.d/nix.fish",
);

runPrivilegedCommand("cp", [
  `${import.meta.dirname}/nix.conf`,
  "/etc/nix/nix.conf",
]);
runPrivilegedCommand("systemctl", ["stop", "nix-daemon.service"]);
runPrivilegedCommand("systemctl", ["restart", "nix-daemon.socket"]);

runCommand("nix", [
  "profile",
  "install",
  "--accept-flake-config",
  "nixpkgs#devenv",
]);
runCommand("nix", [
  "profile",
  "install",
  "--accept-flake-config",
  "github:flox/flox",
]);
