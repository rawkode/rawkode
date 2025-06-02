import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";
import { conditions } from "@korora-tech/dhd/core/conditions.ts";

export default defineModule("kde")
	.description("KDE desktop environment")
	.tags("desktop", "kde", "ui")
	.when(conditions.isKde)
	.packageInstall({
		manager: "pacman",
		packages: ["kaccounts-providers", "kio-gdrive"],
	})
	.build();
