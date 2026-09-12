import m0000 from "./20260910220532_github_app_mirror/migration.sql";
import m0001 from "./20260910221115_webhook_processed/migration.sql";
import m0002 from "./20260910224315_complete_korath/migration.sql";

export default {
	migrations: {
		"20260910220532_github_app_mirror": m0000,
		"20260910221115_webhook_processed": m0001,
		"20260910224315_complete_korath": m0002,
	},
};
