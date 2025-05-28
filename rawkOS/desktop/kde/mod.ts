import { defineModule } from "../../core/module-builder.ts";
import { conditions } from "../../core/conditions.ts";

export default defineModule("kde")
	.description("KDE desktop environment")
	.tags("desktop", "kde", "ui")
	.when(conditions.isKde)
	.packageInstall({
		manager: "pacman",
		packages: ["kaccounts-providers", "kio-gdrive"],
	})
	.build();
