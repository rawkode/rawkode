import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await archInstall(["direnv"]);

ensureHomeSymlink(
  `${import.meta.dirname}/direnv.fish`,
  ".config/fish/conf.d/direnv.fish",
);

ensureHomeSymlink(
  `${import.meta.dirname}/direnv.nu`,
  ".config/nushell/autoload/direnv.nu",
);
