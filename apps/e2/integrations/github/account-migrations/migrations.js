import m0000 from "./20260910220532_github_app_mirror/migration.sql";
import m0001 from "./20260910221115_webhook_processed/migration.sql";

export default {
	migrations: {
		"20260910220532_github_app_mirror": m0000,
		"20260910221115_webhook_processed": m0001,
	},
};
