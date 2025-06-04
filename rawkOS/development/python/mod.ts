import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("python")
	.description("Python programming language")
	.tags("development", "programming", "python")
	.with(() => [
		packageInstall({
			names: ["uv"],
	}),
	]);
