{ lib, pkgs, ... }:
{
  home.file.".bashrc".source = ./auto-fish.sh;

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

    binds = {
      "ctrl-\\[".command = "builtin cd ..; commandline -f repaint";
    };

    interactiveShellInit = lib.rawkOS.fileAsSeparatedString ./interactiveInit.fish;

    functions = {
      magic-enter = {
        description = "Magic Enter";
        body = lib.rawkOS.fileAsSeparatedString ./magic-enter.fish;
      };

      magic-enter-command = {
        description = "Magic Enter AutoCommands";
        body = lib.rawkOS.fileAsSeparatedString ./magic-enter-command.fish;
      };
    };
  };
}
