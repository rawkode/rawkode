let
  name = "David Flanagan";
  email = "david@rawkode.dev";
in
{
  imports = [
    ./delta.nix
    ./fish.nix
    ./gitsign.nix
    ./jujutsu.nix
  ];

  programs.git = {
    enable = true;
    lfs.enable = true;

    userName = name;
    userEmail = email;

    aliases = {
      cane = "commit --amend --no-edit";
      co = "checkout";
      logp = "log --pretty=shortlog";
      logs = "log --show-signatures";
      pl = "pull --ff-only";
      prune = "fetch --prune";
      ps = "push";
      root = "rev-parse --show-toplevel";
    };

    extraConfig = {
      init.defaultBranch = "main";

      advice = {
        statusHints = false;
      };

      core = {
        editor = "code --wait";
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
    };

    ignores = [
      "*logs*"
      "*.log"
      "*~"
      ".DS_Store"
    ];
  };

  home.file.".config/git/templates/commit.txt".source = ./git-commit-template.txt;
}
