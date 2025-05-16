import { ensureDirSync, ensureSymlinkSync, removeSync } from "fs-extra";

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
  ensureDirSync(`${home}/.config/starship`);

  if (options.force) {
    removeSync(`${home}/${link}`);
  }

  ensureSymlinkSync(file, `${home}/${link}`);
};
