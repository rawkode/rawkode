import { ensureSymlinkSync } from "@std/fs/ensure-symlink";
import { ensureDirSync } from "@std/fs";

interface Options {
  force?: boolean;
}

const DefaultOptions: Options = {
  force: false,
};

export const ensureHomeSymlink = (
  file: string,
  link: string,
  options: Options = DefaultOptions,
) => {
  ensureDirSync(`${Deno.env.get("HOME")}/.config/starship`);

  if (options.force) {
    Deno.removeSync(`${Deno.env.get("HOME")}/${link}`);
  }

  ensureSymlinkSync(
    file,
    `${Deno.env.get("HOME")}/${link}`,
  );
};
