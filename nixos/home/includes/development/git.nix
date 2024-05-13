{ config, pkgs, ... }:

{
  programs.git = {
    enable = true;

    userName  = "David Flanagan";
    userEmail = "david@rawkode.dev";

    # signing = {
    #   key = "2D8641614CBEDB36443A1F1C4E81F61612CDF165";
    #   signByDefault = true;
    # };

    aliases = {
      cane = "commit --amend --no-edit";
      co = "checkout";
      logp = "log --pretty=shortlog";
      logs = "log --show-signatures";
      pl = "pull --ff-only";
      prune = "fetch --prune";
      ps = "push";
    };

    extraConfig = {
      advice = {
        statusHints = false;
      };

      branch = {
        autosetuprebase = "always";
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
      };

      diff = {
        algorithm = "minimal";
        renames = "copies";
        tool = "code";
      };

      "difftool \"code\"" = {
        cmd = "code --wait --diff $LOCAL $REMOTE";
      };

      log = {
        date = "relative";
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
      };

      rebase = {
        autostash = true;
      };

      rerere = {
        enabled = true;
      };

      stash = {
        showPatch = true;
      };
    };

    ignores = [
      "*logs*"
      "*.log"
      "*~"
      ".DS_Store"
      ".vscode"
    ];
  };

  home.file.".config/git/templates/commit.txt".source = ./git-commit-template.txt;
}
