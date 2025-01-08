import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

ensureHomeSymlink(
  `${import.meta.dirname}/go.fish`,
  ".config/fish/conf.d/go.fish",
);

archInstall(["go"]);
