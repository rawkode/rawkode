import { whichSync } from "@david/which";

interface Options {
	allowFailure: boolean;
}

const DefaultOptions: Options = {
	allowFailure: false,
}

export const runCommand = (command: string, args: string[], options: Options = DefaultOptions) => {
  const commandPath = command.startsWith("/") ? command : whichSync(command);

  if (!commandPath) {
    console.error(`Command not found: ${command}`);
    Deno.exit(1);
  }

  const result = new Deno.Command(commandPath, {
    args,
    stdin: "inherit",
    stderr: "inherit",
    stdout: "inherit",
  }).outputSync();

	if (options.allowFailure) {
		// Doesn't really matter what the exit code is
		// unless we decide to print some warnings later
		return;
	}

  if (result.code !== 0) {
    console.error(`Error running command: ${command} ${args.join(" ")}`);
    Deno.exit();
  }
};

export const runPrivilegedCommand = (command: string, args: string[]) => {
  runCommand("sudo", [command, ...args]);
};
