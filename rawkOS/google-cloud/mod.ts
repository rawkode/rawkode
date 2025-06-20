// TODO
// import { existsSync } from "node:fs";

// const home = import.meta.env.HOME;

// export default defineModule("google-cloud")
// 	.description("Google Cloud SDK")
// 	.tags(["developer"])
// 	.tags(["cli", "cloud", "gcp"])
// 	.actions([
// 		customAction({
// 			name: "Install Google Cloud SDK",
// 			description: "Download and install Google Cloud SDK",
// 			async plan(context) {
// 				const sdkPath = `${context.system.user.home}/.local/google-cloud-sdk`;
// 				const effects = [];

// 				if (!existsSync(sdkPath)) {
// 					effects.push({
// 						type: "command_run" as const,
// 						description: "Download Google Cloud SDK",
// 						source: "/tmp/google-cloud-sdk.tar.gz",
// 					});
// 					effects.push({
// 						type: "command_run" as const,
// 						description: "Extract Google Cloud SDK",
// 						source: sdkPath,
// 					});
// 				}

// 				effects.push({
// 					type: "command_run" as const,
// 					description: "Install Google Cloud SDK",
// 					source: "install.sh",
// 				});

// 				return effects;
// 			},
// 			async apply(context) {
// 				if (context.dryRun) return;

// 				const sdkPath = `${context.system.user.home}/.local/google-cloud-sdk`;
// 				const { runCommand } = await import(
// 					"@korora-tech/dhd/utils/commands/mod.ts"
// 				);

// 				if (!existsSync(sdkPath)) {
// 					await runCommand(
// 						"curl",
// 						[
// 							"-o",
// 							"/tmp/google-cloud-sdk.tar.gz",
// 							"https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz",
// 						],
// 						{ verbose: context.verbose },
// 					);

// 					await runCommand(
// 						"tar",
// 						[
// 							"-xzf",
// 							"/tmp/google-cloud-sdk.tar.gz",
// 							"-C",
// 							`${context.system.user.home}/.local`,
// 						],
// 						{ verbose: context.verbose },
// 					);
// 				}

// 				await runCommand(
// 					"bash",
// 					[
// 						`${sdkPath}/install.sh`,
// 						"--usage-reporting=false",
// 						"--path-update=false",
// 						"--quiet",
// 					],
// 					{ verbose: context.verbose },
// 				);
// 			},
// 		}),
// 		linkFile({
// 			target: "google-cloud.fish",
// 			source: "fish/conf.d/google-cloud.fish",
// 			force: true,
// 		}),
// 	]);
