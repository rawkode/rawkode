// rawkCue - CUE-based Dotfile Management
// Root unification file that imports and validates all modules
package rawkCue

import (
	"github.com/rawkode/rawkcue/schema"

	// Import all modules
	onepassword "github.com/rawkode/rawkcue/modules/1password:onepassword"
	alttab "github.com/rawkode/rawkcue/modules/alt-tab:alttab"
	"github.com/rawkode/rawkcue/modules/atuin"
	"github.com/rawkode/rawkcue/modules/bat"
	"github.com/rawkode/rawkcue/modules/biome"
	"github.com/rawkode/rawkcue/modules/bloom"
	"github.com/rawkode/rawkcue/modules/bun"
	"github.com/rawkode/rawkcue/modules/carapace"
	"github.com/rawkode/rawkcue/modules/chatgpt"
	"github.com/rawkode/rawkcue/modules/chrome"
	claudecode "github.com/rawkode/rawkcue/modules/claude-code:claudecode"
	"github.com/rawkode/rawkcue/modules/codex"
	"github.com/rawkode/rawkcue/modules/cue"
	"github.com/rawkode/rawkcue/modules/cuenv"
	"github.com/rawkode/rawkcue/modules/dagger"
	"github.com/rawkode/rawkcue/modules/descript"
	"github.com/rawkode/rawkcue/modules/direnv"
	"github.com/rawkode/rawkcue/modules/discord"
	"github.com/rawkode/rawkcue/modules/docker"
	"github.com/rawkode/rawkcue/modules/droid"
	"github.com/rawkode/rawkcue/modules/eza"
	"github.com/rawkode/rawkcue/modules/fantastical"
	firefoxdev "github.com/rawkode/rawkcue/modules/firefox-dev:firefoxdev"
	"github.com/rawkode/rawkcue/modules/fish"
	fontmonaspace "github.com/rawkode/rawkcue/modules/font-monaspace:fontmonaspace"
	"github.com/rawkode/rawkcue/modules/fzf"
	geminicli "github.com/rawkode/rawkcue/modules/gemini-cli:geminicli"
	"github.com/rawkode/rawkcue/modules/ghostty"
	"github.com/rawkode/rawkcue/modules/git"
	gitdelta "github.com/rawkode/rawkcue/modules/git-delta:gitdelta"
	gitlfs "github.com/rawkode/rawkcue/modules/git-lfs:gitlfs"
	"github.com/rawkode/rawkcue/modules/github"
	gomod "github.com/rawkode/rawkcue/modules/go:go"
	googlecloud "github.com/rawkode/rawkcue/modules/google-cloud:googlecloud"
	"github.com/rawkode/rawkcue/modules/helix"
	"github.com/rawkode/rawkcue/modules/htop"
	"github.com/rawkode/rawkcue/modules/jq"
	"github.com/rawkode/rawkcue/modules/jujutsu"
	"github.com/rawkode/rawkcue/modules/just"
	"github.com/rawkode/rawkcue/modules/macos"
	"github.com/rawkode/rawkcue/modules/mimestream"
	"github.com/rawkode/rawkcue/modules/moon"
	"github.com/rawkode/rawkcue/modules/node"
	"github.com/rawkode/rawkcue/modules/orion"
	"github.com/rawkode/rawkcue/modules/pulumi"
	"github.com/rawkode/rawkcue/modules/ripgrep"
	"github.com/rawkode/rawkcue/modules/rustup"
	"github.com/rawkode/rawkcue/modules/skim"
	"github.com/rawkode/rawkcue/modules/slack"
	"github.com/rawkode/rawkcue/modules/sqlite"
	"github.com/rawkode/rawkcue/modules/starship"
	"github.com/rawkode/rawkcue/modules/user"
	"github.com/rawkode/rawkcue/modules/uv"
	"github.com/rawkode/rawkcue/modules/vscode"
	"github.com/rawkode/rawkcue/modules/warp"
	"github.com/rawkode/rawkcue/modules/zoxide"
)

// Collect all modules into a single list
modules: [...schema.#Module] & [
	onepassword."1password",
	alttab."alt-tab",
	atuin.atuin,
	bat.bat,
	biome.biome,
	bloom.bloom,
	bun.bun,
	carapace.carapace,
	chatgpt.chatgpt,
	chrome.chrome,
	claudecode."claude-code",
	codex.codex,
	cue.cue,
	cuenv.cuenv,
	dagger.dagger,
	descript.descript,
	direnv.direnv,
	discord.discord,
	docker.docker,
	droid.droid,
	eza.eza,
	fantastical.fantastical,
	firefoxdev."firefox-dev",
	fish.fish,
	fontmonaspace."font-monaspace",
	fzf.fzf,
	geminicli."gemini-cli",
	ghostty.ghostty,
	git.git,
	gitdelta."git-delta",
	gitlfs."git-lfs",
	github.github,
	gomod.go,
	googlecloud."google-cloud",
	helix.helix,
	htop.htop,
	jq.jq,
	jujutsu.jujutsu,
	just.just,
	macos.macos,
	mimestream.mimestream,
	moon.moon,
	node.node,
	orion.orion,
	pulumi.pulumi,
	ripgrep.ripgrep,
	rustup.rustup,
	skim.skim,
	slack.slack,
	sqlite.sqlite,
	starship.starship,
	user.user,
	uv.uv,
	vscode.vscode,
	warp.warp,
	zoxide.zoxide,
]

// Validation: ensure no duplicate module names
_moduleNames: {for m in modules {(m.name): true}}

// Export configuration for potential executor consumption
output: {
	version: "1.0.0"
	modules: modules
}
