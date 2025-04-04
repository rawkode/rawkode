import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["rustup"]);

ensureHomeSymlink(
  `${import.meta.dirname}/rust.fish`,
  ".config/fish/conf.d/rust.fish",
);
