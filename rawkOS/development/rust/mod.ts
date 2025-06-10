export default defineModule("rust")
	.description("Rust programming language")
	.tags(["development", "programming", "rust"])
	.actions([
		packageInstall({
			names: ["rustup"],
		}),
		linkDotfile({
			from: "rust.fish",
			to: "fish/conf.d/rust.fish",
			force: true,
		}),
		linkDotfile({
			from: "rust.nu",
			to: "nushell/autoload/rust.nu",
			force: true,
		}),
	]);
