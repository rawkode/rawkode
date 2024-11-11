import { addRepository, installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await addRepository({
		name: "visual-studio-code",
		url: "https://packages.microsoft.com/yumrepos/vscode",
		keyUrl: "https://packages.microsoft.com/keys/microsoft.asc",
	});

	await installPackages([
		"code",
	]);
};
