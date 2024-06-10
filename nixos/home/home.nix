{ inputs, lib, pkgs, ... }:

let
  inherit (lib.meta) getExe;
in
{
  imports = [
    ./desktop.nix
    ./development.nix
    ./ghostty.nix
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

    shellAliases = {
      "ghb" = "cd ~/Code/src/github.com";
    };

    interactiveShellInit = ''
      ${getExe pkgs.direnv} hook fish | source
      ${getExe pkgs._1password} completion fish | source
      bind \r magic-enter
      set fish_greeting ""
      fish_vi_key_bindings
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

  programs.gh.enable = true;

  home.packages = (
    with pkgs;
    [
      fishPlugins.github-copilot-cli-fish
      morgen
      nil
      nixfmt-rfc-style
    ]
  );

  home.username = "rawkode";
  home.homeDirectory = "/home/rawkode";
  home.stateVersion = "23.11";
}
