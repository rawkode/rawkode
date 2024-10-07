{ config, pkgs, ... }:

let
  name = "David Flanagan";
  email = "david@rawkode.dev";
in
{
  home.packages = with pkgs; [
    jujutsu
    ssh-tpm-agent
  ];

  programs.ssh = {
    enable = true;

    addKeysToAgent = "true";

    extraConfig = ''
      EnableSSHKeysign yes
      IdentityAgent none
      PKCS11Provider /run/current-system/sw/lib/libtpm2_pkcs11.so
    '';
  };

  home.sessionVariables = {
    SSH_AUTH_SOCK = "/run/user/1000/ssh-tpm-agent.sock";
  };

  programs.fish.interactiveShellInit = ''
    set -x SSH_AUTH_SOCK /run/user/1000/ssh-tpm-agent.sock
  '';

  systemd.user.sockets.ssh-tpm-agent = {
    Install.WantedBy = [ "sockets.target" ];
    Socket = {
      ListenStream = "%t/ssh-tpm-agent.sock";
      SocketMode = "0600";
      Service = "ssh-tpm-agent.service";
    };
  };

  systemd.user.services.ssh-tpm-agent = {
    Install.WantedBy = [ "sockets.target" ];

    Unit = {
      Requires = [ "ssh-tpm-agent.socket" ];
      ConditionEnvironment = "!SSH_AGENT_PID";
    };

    Service = {
      ExecStart = "${pkgs.ssh-tpm-agent}/bin/ssh-tpm-agent -l %t/ssh-tpm-agent.sock";
      PassEnvironment = "SSH_AGENT_PID";
      SuccessExitStatus = 2;
      Type = "simple";
    };
  };

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
      key = "${config.home.homeDirectory}/.ssh/id_ecdsa.pub";
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
        gpgsign = true;
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
