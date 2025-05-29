import { $, which } from "bun";
import * as console from "node:console";
import * as process from "node:process";

interface Options {
	allowFailure?: boolean;
	cwd?: string;
	env?: Record<string, string>;
	silent?: boolean;
	verbose?: boolean;
	onOutput?: (data: string) => void;
	onError?: (data: string) => void;
	needsInput?: boolean;
}

const DefaultOptions: Options = {
	allowFailure: false,
	silent: false,
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

	// Use Bun.spawn for better control over stdout/stderr
	const proc = Bun.spawn([commandPath, ...args], {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdout: "pipe", // Always pipe to detect output
		stderr: "pipe", // Always pipe to detect prompts
		stdin: options.needsInput ? "inherit" : "pipe",
	});

	// Handle output streaming in parallel
	let stdout = "";
	let stderr = "";

	const promises: Promise<void>[] = [];

	// Handle stdout
	if (proc.stdout) {
		promises.push((async () => {
			const stream = proc.stdout!;
			const chunks: Uint8Array[] = [];
			
			for await (const chunk of stream) {
				chunks.push(chunk);
				const text = new TextDecoder().decode(chunk);
				stdout += text;
				
				// Only write to stdout if no callback is provided or if verbose is explicitly true
				if (options.verbose && !options.onOutput) {
					process.stdout.write(text);
				}
				if (options.onOutput) {
					options.onOutput(text);
				}
			}
		})());
	}

	// Handle stderr
	if (proc.stderr) {
		promises.push((async () => {
			const stream = proc.stderr!;
			const chunks: Uint8Array[] = [];
			
			for await (const chunk of stream) {
				chunks.push(chunk);
				const text = new TextDecoder().decode(chunk);
				stderr += text;
				
				// Only write to stderr if no callback is provided or if verbose is explicitly true
				if (options.verbose && !options.onError) {
					process.stderr.write(text);
				}
				if (options.onError) {
					options.onError(text);
				}
			}
		})());
	}

	// Wait for process to exit and streams to close
	const [exitCode] = await Promise.all([
		proc.exited,
		...promises
	]);

	const result = {
		exitCode,
		stdout,
		stderr,
		// Add text method for compatibility
		text: async () => stdout,
	};

	if (!options.allowFailure && exitCode !== 0) {
		if (!options.silent) {
			console.error(`Error running command: ${command} ${args.join(" ")}`);
			// Show stderr on error
			if (stderr.trim()) {
				console.error(stderr);
			}
		}
		process.exit(1);
	}

	return result;
};

export const runPrivilegedCommand = async (
	command: string,
	args: string[],
	options: Options = DefaultOptions,
) => {
	return await runCommand("sudo", [command, ...args], options);
};

let sudoCacheInitialized = false;

export const initSudoCache = async (showMessage = true) => {
	if (sudoCacheInitialized) return;

	if (showMessage) {
		console.log("Authenticating for system changes...");
	}

	// Just validate sudo credentials once at the start
	await runCommand("sudo", ["-v"]);

	sudoCacheInitialized = true;
};
