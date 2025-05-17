import { archInstall } from "../../../utils/package/mod.ts";
import { ensureHomeSymlink } from "../../../utils/files/mod.ts";

await archInstall(["gitui"]);

ensureHomeSymlink(
  `${import.meta.dirname}/theme.ron`,
  ".config/gitui/theme.ron",
);
