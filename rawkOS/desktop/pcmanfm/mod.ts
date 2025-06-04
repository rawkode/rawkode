import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("pcmanfm")
	.description("PCManFM file manager")
	.tags("desktop", "file-manager")
	.with(() => [
		packageInstall({
    names: ["pcmanfm-gtk3"],
  }),
	]);
