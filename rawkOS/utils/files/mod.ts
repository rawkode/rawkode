import { ensureSymlinkSync } from "@std/fs/ensure-symlink";

export const ensureHomeSymlink = (file: string, link: string) =>
	ensureSymlinkSync(
		file,
		`${Deno.env.get("HOME")}/${link}`,
	);
