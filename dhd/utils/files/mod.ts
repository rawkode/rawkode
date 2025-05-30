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
			if (currentTarget === file) {
				// Symlink already exists and points to the correct source
				return;
			}
			// Symlink exists but points to different target, remove it
			removeSync(targetPath);
		} else {
			// Non-symlink file exists, remove it if force is true
			if (options.force) {
				removeSync(targetPath);
			} else {
				throw new Error(`File exists at ${targetPath} and is not a symlink. Use force option to override.`);
			}
		}
	} catch (error: any) {
		// Only proceed if the file doesn't exist (ENOENT)
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}

	// Ensure parent directory exists
	const targetDir = path.dirname(targetPath);
	ensureDirSync(targetDir);

	ensureSymlinkSync(file, targetPath);
};
