const fabric = await fetch(
  "https://github.com/danielmiessler/fabric/releases/latest/download/fabric-linux-amd64",
);

// Can I pull this from go/mod.ts?
Deno.mkdirSync(`${Deno.env.get("HOME")!}/Code/bin`, { recursive: true });

Deno.writeFileSync(
  `${Deno.env.get("HOME")!}/Code/bin/fabric`,
  new Uint8Array(await fabric.arrayBuffer()),
);

Deno.chmodSync(`${Deno.env.get("HOME")!}/Code/bin/fabric`, 0o755);
