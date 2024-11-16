import { ensureHomeSymlink } from "../../utils/files/mod.ts";

ensureHomeSymlink(
	`${import.meta.dirname}/homebrew.fish`,
	".config/fish/conf.d/homebrew.fish",
);
