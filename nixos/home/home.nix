{ lib, pkgs, ... }:

let
  inherit (lib.meta) getExe;
in
{
  imports = [
    ./desktop.nix
    ./development.nix
    ./neovim.nix
    ./shell.nix
    ./web.nix
    ./wezterm.nix
  ];

  nixpkgs.config.allowUnfree = true;

  programs.home-manager = {
    enable = true;
  };

  catppuccin = {
    flavor = "frappe";
    enable = true;
  };

  programs.foot = {
    enable = true;
    settings = {
      main = {
        shell = "${pkgs.zellij}/bin/zellij";
        term = "xterm-256color";
        font = "Monaspace Neon:size=16";
        dpi-aware = true;
        pad = "16x16";
      };
      csd.preferred = "none";
    };
  };

  programs.helix = {
    enable = true;
    settings = {
      editor = {
        color-modes = true;
        cursorline = true;
        line-number = "relative";
        lsp = {
          display-inlay-hints = true;
          display-messages = true;
        };
        true-color = true;
      };
      keys.normal = {
        space.space = "file_picker";
        space.f = ":format";
      };
    };
  };

  programs.ssh = {
    enable = true;
    extraConfig = ''
      IdentityAgent ~/.1password/agent.sock
    '';
  };

  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };

  services.espanso = {
    matches = {
      academy = {
        matches = [
          {
            trigger = ":col";
            replace = "https://rawkode.link/collaborate";
          }
          {
            trigger = "helpme";
            replace = "dodododod";
          }
        ];
      };
    };
  };

  programs.atuin = {
    enable = true;

    enableFishIntegration = true;
    enableNushellIntegration = true;

    settings = {
      style = "compact";
      show_preview = true;

      enter_accept = true;

      search_mode = "skim";
      filter_mode = "directory";
      filter_mode_shell_up_key_binding = "session";
    };
  };

  programs.fish = {
    enable = true;

    interactiveShellInit = ''
      ${getExe pkgs.direnv} hook fish | source
      ${getExe pkgs._1password} completion fish | source
      bind \r magic-enter
    '';

    functions = {
      magic-enter = {
        description = "Magic Enter";
        body = ''
          set -l cmd (commandline)
          if test -z "$cmd"
            commandline -r (magic-enter-command)
            commandline -f suppress-autosuggestion
          end
          commandline -f execute
        '';
      };

      magic-enter-command = {
        description = "Magic Enter AutoCommands";
        body = ''
          set -l cmd ll
          set -l is_git_repository (fish -c "git rev-parse --is-inside-work-tree >&2" 2>| grep true) # Special variable indicating git.
          set -l repo_has_changes (git status -s --ignore-submodules=dirty)

          if test -n "$is_git_repository"
            if test -n "$repo_has_changes"
              set cmd git status
            end
          end

          echo $cmd
        '';
      };
    };
  };

  home.packages = (
    with pkgs;
    [
      fishPlugins.github-copilot-cli-fish
      nil
      nixfmt-rfc-style
    ]
  );

  home.username = "rawkode";
  home.homeDirectory = "/home/rawkode";
  home.stateVersion = "23.11";
}
