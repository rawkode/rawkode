export default defineModule("git")
    .description("Git version control")
    .tags(["terminal"])
    .actions([
        packageInstall({
            names: ["gitsign"],
        }),
        gitConfig({
            global: {
                user: {
                    name: "David Flanagan",
                    email: "david@rawkode.academy"
                },
                init: {
                    defaultBranch: "main"
                },
                core: {
                    editor: "zeditor --wait"
                },
                gpg: {
                    program: "gpg",
                    format: "x509"
                },
                "gpg.x509": {
                    program: "gitsign"
                },
                commit: {
                    gpgSign: "true"
                },
                alias: {
                    cane: "commit --amend --no-edit",
                    co: "checkout",
                    logp: "log --pretty=shortlog",
                    logs: "log --show-signatures",
                    pl: "pull --ff-only",
                    prune: "fetch --prune",
                    ps: "push",
                    root: "rev-parse --show-toplevel"
                },
                branch: {
                    autoSetupRebase: "always"
                },
                pull: {
                    default: "current",
                    rebase: "true"
                },
                push: {
                    default: "current",
                    autoSetupRemote: "true"
                },
                rebase: {
                    autosquash: "true",
                    autostash: "true"
                },
                rerere: {
                    enabled: "true"
                },
                stash: {
                    showPatch: "true"
                },
                advice: {
                    statusHints: "false"
                },
                color: {
                    diff: "true",
                    status: "true",
                    branch: "true",
                    interactive: "true",
                    ui: "true"
                },
                diff: {
                    algorithm: "minimal",
                    renames: "copies",
                    tool: "code"
                },
                "difftool.code": {
                    cmd: "code --wait --diff $LOCAL $REMOTE"
                },
                pretty: {
                    shortlog: "format:%C(auto,yellow)%h%C(auto,magenta)% G? %C(auto,cyan)%>(12,trunc)%ad%C(auto,green) %aN %C(auto,reset)%s%C(auto,red)% gD% D"
                },
                "credential.https://github.com": {
                    helper: ["", "!/usr/bin/gh auth git-credential"]
                },
                "credential.https://gist.github.com": {
                    helper: ["", "!/usr/bin/gh auth git-credential"]
                }
            }
        }),
        linkFile({
            target: "git.nu",
            source: "nushell/autoload/git.nu",
            force: true,
        }),
        linkFile({
            target: "gitsign.fish",
            source: "fish/conf.d/gitsign.fish",
            force: true,
        }),
        linkFile({
            target: "gitsign.nu",
            source: "nushell/autoload/gitsign.nu",
            force: true,
        }),
        directory({
            path: "~/.cache/sigstore/gitsign",
        }),
        httpDownload({
            url: "https://github.com/sigstore/gitsign/releases/download/v0.11.0/gitsign-credential-cache_0.11.0_linux_amd64",
            destination: "~/Code/bin/gitsign-credential-cache",
            checksum: {
                algorithm: "sha256",
                value: "cfd2bf2c0e81668a7b9263e3b76c857783d6edad2ad43a4013da4be1346b9fb5",
            },
            mode: 0o755,
        }),
        systemdSocket({
            name: "gitsign-credential-cache.socket",
            description: "Gitsign credential cache socket",
            listenStream: "%h/.cache/sigstore/gitsign/cache.sock",
            scope: "user",
        }),
        systemdService({
            name: "gitsign-credential-cache.service",
            description: "Gitsign credential cache daemon",
            execStart: "%h/Code/bin/gitsign-credential-cache",
            serviceType: "simple",
            scope: "user",
            restart: "on-failure",
            restartSec: 5,
        }),
    ]);
