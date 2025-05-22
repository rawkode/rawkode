import { archInstall } from "../../utils/package/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";

// Install eza package using the Arch package manager helper.
await archInstall(["eza"]);

// Ensure the eza.fish configuration file is symlinked to the
// fish shell's configuration directory. This will make our
// aliases and eza's Fish integration available.
ensureHomeSymlink(
  `${import.meta.dirname}/eza.fish`,
  ".config/fish/conf.d/eza.fish",
);