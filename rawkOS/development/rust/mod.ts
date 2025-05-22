import { $ } from "bun";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["rustup"]);

await $`rustup default stable`;

ensureHomeSymlink(
  `${import.meta.dirname}/rust.fish`,
  ".config/fish/conf.d/rust.fish",
);

ensureHomeSymlink(
  `${import.meta.dirname}/rust.nu`,
  ".config/nushell/autoload/rust.nu",
);
