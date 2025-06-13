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
			// This needs early loading, as it configures PATH for Rust installed packages
			source: "nushell/autoload/0-rust.nu",
			force: true,
		}),
	]);
