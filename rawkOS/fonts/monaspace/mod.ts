import { $ } from "zx";

export default async () => {
	await $`git clone https://github.com/githubnext/monaspace /tmp/monaspace`;
	await $`mkdir -p /usr/share/fonts/Monaspace/`;
	await $`bash -c 'cp /tmp/monaspace/fonts/otf/* /usr/share/fonts/Monaspace/'`;
	await $`bash -c 'cp /tmp/monaspace/fonts/variable/* /usr/share/fonts/Monaspace/'`;
	await $`fc-cache --system-only --really-force /usr/share/fonts/Monaspace/`;
	await $`rm -rf /tmp/monaspace`;
};
