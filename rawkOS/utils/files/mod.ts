import { ensureSymlinkSync } from "@std/fs/ensure-symlink";
import { ensureDirSync } from "@std/fs";

export const ensureHomeSymlink = (file: string, link: string) => {
	ensureDirSync(`${Deno.env.get("HOME")}/.config/starship`);

	ensureSymlinkSync(
		file,
		`${Deno.env.get("HOME")}/${link}`,
	);
};
