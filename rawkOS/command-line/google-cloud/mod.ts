import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

archInstall(["google-cloud-cli"]);
ensureHomeSymlink(`${import.meta.dirname}/google-cloud.fish`, ".config/fish/conf.d/google-cloud.fish");
