import { ensureDirSync, ensureSymlinkSync, removeSync } from "fs-extra";
import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";

interface Options {
	force?: boolean;
}

const DefaultOptions: Options = {
	force: false,
};

const home = import.meta.env.HOME;

export const ensureHomeSymlink = (
	file: string,
	link: string,
	options: Options = DefaultOptions,
) => {
	const targetPath = `${home}/${link}`;

	// Check if symlink already exists and points to the correct source
	try {
		const stats = lstatSync(targetPath);
		if (stats.isSymbolicLink()) {
			const currentTarget = readlinkSync(targetPath);
			if (currentTarget === file && !options.force) {
				// Symlink already exists and points to the correct source
				return;
			}
		}
	} catch (error) {
		// File doesn't exist, proceed to create symlink
	}

	// Ensure parent directory exists
	const targetDir = path.dirname(targetPath);
	ensureDirSync(targetDir);

	if (options.force) {
		removeSync(targetPath);
	}

	ensureSymlinkSync(file, targetPath);
};
