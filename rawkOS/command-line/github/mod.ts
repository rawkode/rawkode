import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

ensureHomeSymlink(`${import.meta.dirname}/known_hosts`, ".ssh/known_hosts");
archInstall(["github-cli"]);
