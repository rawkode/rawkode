export const dconfImport = async (importPath: string, rootPath: string = "/") => {
	const command = new Deno.Command("dconf", {
		args: ["load", rootPath],
		stdin: "piped",
		stdout: "inherit",
		stderr: "inherit",
	}).spawn();

	const stdin = command.stdin.getWriter();

	await stdin.write(Deno.readFileSync(importPath));
	await stdin.ready;
	await stdin.close();
};
