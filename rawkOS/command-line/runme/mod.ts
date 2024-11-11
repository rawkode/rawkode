import { installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await installPackages([
		"https://github.com/stateful/runme/releases/latest/download/runme_linux_x86_64.rpm",
	]);
};
