{ pkgs, ... }:

let
  name = "David Flanagan";
  email = "david@rawkode.dev";
  publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAXwFFDFPDUbAql+V8xMmFxuZe6aUUxDD2cY0Dr0X1g9";
in
{
  xdg.configFile."git/allowed_signers".text = ''
    ${email} namespaces="git" ${publicKey}
  '';

  home.packages = with pkgs; [ jujutsu ];

  programs.fish = {
    shellAbbrs = {
      gr = {
        expansion = "cd (git root)";
        position = "command";
      };
    };
  };

  programs.git = {
    enable = true;
    lfs.enable = true;

    userName = name;
    userEmail = email;

    signing = {
      key = publicKey;
      signByDefault = true;
    };

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
      push.autoSetupRemote = true;
      init.defaultBranch = "main";

      core = {
        editor = "code --wait";
      };

      gpg = {
        format = "ssh";
        ssh.program = "/opt/1Password/op-ssh-sign";
        ssh.allowedSignersFile = "~/.config/git/allowed_signers";
      };

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
