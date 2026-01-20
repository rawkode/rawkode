{ inputs, lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "git";

  common.home =
    {
      pkgs,
      identity,
      preferences,
      ...
    }:
    {
      imports = with inputs.self.homeModules; [
        git-delta
        git-fish
      ];

      programs.git = {
        enable = true;
        lfs.enable = true;

        signing = {
          key = identity.signingKey;
          signByDefault = identity.signingKey != null;
        };

        ignores = [
          "*logs*"
          "*.log"
          "*~"
          ".DS_Store"
        ];

        settings = {
          core.editor = preferences.editor;

          user = {
            inherit (identity) name;
            inherit (identity) email;
          };

          alias = {
            cane = "commit --amend --no-edit";
            logp = "log --pretty=shortlog";
            logs = "log --show-signatures";
            prune = "fetch --prune";
            root = "rev-parse --show-toplevel";
          };

          init.defaultBranch = "main";

          credential.helper = [
            "cache --timeout 21600"
          ];

          advice = {
            statusHints = false;
          };

          column = {
            ui = "auto";
          };

          branch = {
            autosetuprebase = "always";
            sort = "committerdate";
          };

          color = {
            diff = "true";
            status = "true";
            branch = "true";
            interactive = "true";
            ui = "true";
          };

          commit = {
            template = "~/.config/git/templates/commit.txt";
            verbose = true;
            gpgsign = identity.signingKey != null;
          };

          diff = {
            algorithm = "histogram";
            colorMoved = "plain";
            mnemonicPrefix = true;
            renames = "copies";
            tool = "code";
          };

          "difftool \"code\"" = {
            cmd = "code --wait --diff $LOCAL $REMOTE";
          };

          fetch = {
            all = true;
            prune = true;
            pruneTags = true;
          };

          log = {
            date = "relative";
          };

          merge = {
            conflictStyle = "zdiff3";
          };

          pretty = {
            shortlog = "format:%C(auto,yellow)%h%C(auto,magenta)% G? %C(auto,cyan)%>(12,trunc)%ad%C(auto,green) %aN %C(auto,reset)%s%C(auto,red)% gD% D";
          };

          pull = {
            default = "current";
            rebase = true;
          };

          push = {
            default = "current";
            autoSetupRemote = true;
            followTags = true;
          };

          rebase = {
            autoSquash = true;
            autoStash = true;
            updateRefs = true;
          };

          rerere = {
            enabled = true;
            autoupdate = true;
          };

          stash = {
            showPatch = true;
          };

          tag = {
            sort = "version:refname";
          };

          gpg = {
            format = "ssh";
            ssh.program =
              if pkgs.stdenv.isDarwin then
                "/Applications/1Password.app/Contents/MacOS/op-ssh-sign"
              else
                "${pkgs._1password-gui}/bin/op-ssh-sign";
          };
        };
      };

      home.file.".config/git/templates/commit.txt".source = ./git-commit-template.txt;
    };
}
