import { $, which } from "bun";
import * as console from "node:console";
import * as process from "node:process";

interface Options {
  allowFailure: boolean;
}

const DefaultOptions: Options = {
  allowFailure: false,
};

export const runCommand = async (
  command: string,
  args: string[],
  options: Options = DefaultOptions,
) => {
  const commandPath = command.startsWith("/") ? command : which(command);

  if (!commandPath) {
    console.error(`Command not found: ${command}`);
    process.exit(1);
  }

  if (options.allowFailure) {
    $.nothrow();
  }

  const result = await $`${commandPath} ${args}`;

  $.throws(true);

  if (!options.allowFailure && result.exitCode !== 0) {
    console.error(`Error running command: ${command} ${args.join(" ")}`);
    process.exit(1);
  }
};

export const runPrivilegedCommand = async (command: string, args: string[]) => {
  return await runCommand("sudo", [command, ...args]);
};
