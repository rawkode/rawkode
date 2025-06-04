import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("rust")
	.description("Rust programming language")
	.tags("development", "programming", "rust")
	.with(() => [
		packageInstall({
			names: ["rustup"],
	}),
		linkDotfile({
			source: "rust.fish",
		target: "fish/conf.d/rust.fish",
	}),
		linkDotfile({
			source: "rust.nu",
		target: "nushell/autoload/rust.nu",
	}),
	]);
