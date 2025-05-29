import { runCommand } from "../commands/mod.ts";
import process from "node:process";

// Simple mutex implementation for package operations
class PackageMutex {
  private locked = false;
  private queue: (() => void)[] = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    } else {
      this.locked = false;
    }
  }
}

// Global mutex for package operations
const packageMutex = new PackageMutex();

export const isArchPackageInstalled = async (
  packageName: string,
): Promise<boolean> => {
  try {
    const result = await runCommand("pacman", ["-Q", packageName], {
      silent: true,
      allowFailure: true,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

export const isBunPackageInstalled = async (
  packageName: string,
): Promise<boolean> => {
  try {
    const result = await runCommand(
      "bun",
      ["pm", "ls", "--global", packageName],
      {
        silent: true,
        allowFailure: true,
      },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

export const isFlatpakInstalled = async (
  packageId: string,
): Promise<boolean> => {
  try {
    const result = await runCommand(
      "flatpak",
      ["list", "--app", "--columns=application"],
      { silent: true, allowFailure: true },
    );
    const stdout =
      typeof result.text === "function"
        ? await result.text()
        : result.stdout?.toString() || "";
    return stdout.includes(packageId);
  } catch {
    return false;
  }
};

export const isBrewPackageInstalled = async (
  packageName: string,
): Promise<boolean> => {
  try {
    const result = await runCommand(
      "/home/linuxbrew/.linuxbrew/bin/brew",
      ["list", packageName],
      { silent: true, allowFailure: true },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

export const isGoPackageInstalled = async (
  packageName: string,
): Promise<boolean> => {
  try {
    // Extract the binary name from the package path
    const binaryName =
      packageName.split("/").pop()?.split("@")[0] || packageName;
    const result = await runCommand("which", [binaryName], {
      silent: true,
      allowFailure: true,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

export const isCargoPackageInstalled = async (
  packageName: string,
): Promise<boolean> => {
  try {
    const result = await runCommand("cargo", ["install", "--list"], {
      silent: true,
      allowFailure: true,
    });
    const stdout =
      typeof result.text === "function"
        ? await result.text()
        : result.stdout?.toString() || "";
    return stdout.includes(packageName);
  } catch {
    return false;
  }
};

export const archInstall = async (
  packages: string[],
  options: {
    verbose?: boolean;
    onOutput?: (data: string) => void;
    onError?: (data: string) => void;
  } = {},
) => {
  // Acquire the mutex before installing packages
  await packageMutex.acquire();

  try {
    // Only emit console messages if no callback is provided
    if (!options.onOutput) {
      console.log(`Installing packages: ${packages.join(", ")}...`);
    }

    await runCommand(
      "paru",
      [
        "--sync",
        ...packages,
        "--needed",
        "--noconfirm",
        "--skipreview",
        "--removemake",
        "--cleanafter",
      ],
      options,
    );

    if (!options.onOutput) {
      console.log(`Finished installing packages: ${packages.join(", ")}`);
    }
  } finally {
    // Always release the mutex, even if installation fails
    packageMutex.release();
  }
};

export const bunInstall = async (
  packages: string[],
  options: { verbose?: boolean } = {},
) => {
  console.log(`Installing packages: ${packages.join(", ")}...`);

  await runCommand("bun", ["add", "--global", ...packages], {
    verbose: options.verbose,
    silent: !options.verbose,
  });

  console.log(`Finished installing packages: ${packages.join(", ")}`);
};

export const flatpakInstall = async (
  packages: string[],
  options: { verbose?: boolean } = {},
) => {
  console.log(`Installing packages: ${packages.join(", ")}...`);

  await runCommand(
    "flatpak",
    ["install", "--assumeyes", "flathub", ...packages],
    { verbose: options.verbose },
  );

  console.log(`Finished installing packages: ${packages.join(", ")}`);
};

export const brewInstall = async (
  packages: string[],
  options: { verbose?: boolean } = {},
) => {
  console.log(`Installing packages: ${packages.join(", ")}...`);

  await runCommand(
    "/home/linuxbrew/.linuxbrew/bin/brew",
    ["install", ...packages],
    { verbose: options.verbose },
  );

  console.log(`Finished installing packages: ${packages.join(", ")}`);
};

export const goInstall = async (
  packageName: string,
  options: { verbose?: boolean } = {},
) => {
  console.log(`Installing package: ${packageName}...`);

  const home = process.env.HOME || import.meta.env.HOME;
  await runCommand("go", ["install", packageName], {
    verbose: options.verbose,
    env: {
      GOPATH: `${home}/Code`,
    },
  });

  console.log(`Finished installing package: ${packageName}`);
};

interface CargoInstallOptions {
  useGit?: boolean;
}

export const cargoInstall = async (
  packageName: string,
  options: CargoInstallOptions & { verbose?: boolean },
) => {
  console.log(`Installing package: ${packageName}...`);

  await runCommand(
    "cargo",
    ["install", ...(options.useGit ? ["--git"] : []), packageName],
    { verbose: options.verbose },
  );

  console.log(`Finished installing package: ${packageName}`);
};
