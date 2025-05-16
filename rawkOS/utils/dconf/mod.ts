import { $ } from "bun";
import { readFileSync } from "fs-extra";

export const dconfImport = async (
  importPath: string,
  rootPath: string = "/",
) => {
  await $`dconf load ${rootPath} < ${readFileSync(importPath)}`;
};
