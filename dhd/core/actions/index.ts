import { ActionRegistry } from "../action.ts";
import { PackageInstallAction } from "./package.ts";
import { SymlinkAction, FileWriteAction, FileCopyAction } from "./file.ts";
import { CommandAction } from "./command.ts";
import { ConditionalAction } from "./conditional.ts";
import { HttpDownloadAction } from "./http.ts";

export function registerCoreActions() {
	ActionRegistry.register("package.install", PackageInstallAction as any);
	ActionRegistry.register("file.symlink", SymlinkAction as any);
	ActionRegistry.register("file.write", FileWriteAction as any);
	ActionRegistry.register("file.copy", FileCopyAction as any);
	ActionRegistry.register("command.run", CommandAction as any);
	ActionRegistry.register("conditional", ConditionalAction as any);
	ActionRegistry.register("http.download", HttpDownloadAction as any);
}

export * from "./package.ts";
export * from "./file.ts";
export * from "./command.ts";
export * from "./conditional.ts";
export * from "./http.ts";
