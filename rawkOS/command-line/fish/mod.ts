import { installPackages } from "../../utils/package/mod.ts";

export default async () => {
	await installPackages(["fish"]);
};
