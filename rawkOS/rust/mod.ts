export default defineModule("rust")
	.description("Rust programming language")
	.tags(["development"])
	.actions([
		packageInstall({
			names: ["rustup"],
		}),
		linkFile({
			target: "rust.fish",
			source: "fish/conf.d/rust.fish",
			force: true,
		}),
		linkFile({
			target: "rust.nu",
			source: "nushell/autoload/rust.nu",
			force: true,
		}),
	]);
