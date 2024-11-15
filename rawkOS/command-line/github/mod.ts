import { archInstall } from "../../utils/package/mod.ts";

const home = Deno.env.get("HOME");

Deno.writeFileSync(`${home}/.ssh/known_hosts`, Deno.readFileSync(`${import.meta.dirname}/known_hosts`));

await archInstall(["github-cli"]);
