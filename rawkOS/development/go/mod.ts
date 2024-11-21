import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["go"]);

ensureHomeSymlink(
  `${import.meta.dirname}/go.fish`,
  ".config/fish/conf.d/go.fish",
);
