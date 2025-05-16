import { ensureHomeSymlink } from "../../utils/files/mod.ts";

ensureHomeSymlink(
	`${import.meta.dirname}/deno.fish`,
	".config/fish/conf.d/deno.fish",
);
