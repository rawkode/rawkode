{ pkgs, ... }:
{
  home.file.".bashrc" = { source = ./auto-fish.sh; };

  programs.fish = {
    enable = true;

    plugins = [
      {
        name = "nix-env";
        src = pkgs.fetchFromGitHub {
          owner = "lilyball";
          repo = "nix-env.fish";
          rev = "7b65bd228429e852c8fdfa07601159130a818cfa";
          hash = "sha256-RG/0rfhgq6aEKNZ0XwIqOaZ6K5S4+/Y5EEMnIdtfPhk";
        };
      }
    ];

    shellAliases = {
      ghb = "cd ~/Code/src/github.com";
    };

    interactiveShellInit = ''
      set fish_greeting ""
      bind \r magic-enter
      set -gx ZELLIJ_AUTO_ATTACH true
      set -gx ZELLIJ_AUTO_EXIT true
      set -Ux EDITOR "code --wait"
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
          set -l cmd ls
          set -l is_git_repository (fish -c "git rev-parse --is-inside-work-tree >&2" 2>| grep true)

          if test -n "$is_git_repository"
            set -l repo_has_changes (git status -s --ignore-submodules=dirty)
            if test -n "$repo_has_changes"
              set cmd git status
            end
          end

          echo $cmd
        '';
      };
    };
  };
}
