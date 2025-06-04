import { defineModule, packageInstall } from "@korora-tech/dhd";
import { conditions } from "@korora-tech/dhd";

export default defineModule("kde")
	.description("KDE desktop environment")
	.tags("desktop", "kde", "ui")
	.with(() => [
		packageInstall({
			names: ["kaccounts-providers", "kio-gdrive"],
	}),
	]);
