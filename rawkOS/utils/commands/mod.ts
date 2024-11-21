import { whichSync } from "@david/which";

export const runCommand = (command: string, args: string[]) => {
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

  if (result.code !== 0) {
    console.error(`Error running command: ${command} ${args.join(" ")}`);
    Deno.exit();
  }
};

export const runPrivilegedCommand = (command: string, args: string[]) => {
  runCommand("sudo", [command, ...args]);
};
