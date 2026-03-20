# Fish shell configuration
{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };

  # Helper to disable stylix fish theming (we use our own)
  mkStylixFishDisable =
    {
      config,
      lib,
      pkgs,
    }:
    lib.mkIf (pkgs.stdenv.isLinux && lib.attrsets.hasAttrByPath [ "stylix" "targets" "fish" ] config) {
      stylix.targets.fish.enable = lib.mkForce false;
    };
in
mkApp {
  name = "fish";

  linux.system =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    lib.mkMerge [
      (mkStylixFishDisable { inherit config lib pkgs; })
      {
        programs.fish.enable = true;
      }
    ];

  common.home =
    {
      config,
      lib,
      pkgs,
      rawkOSLib,
      ...
    }:
    lib.mkMerge [
      (mkStylixFishDisable { inherit config lib pkgs; })
      {
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

          interactiveShellInit = rawkOSLib.fileAsSeparatedString ./interactiveInit.fish;

          functions = {
            magic-enter = {
              description = "Magic Enter";
              body = rawkOSLib.fileAsSeparatedString ./magic-enter.fish;
            };

            magic-enter-command = {
              description = "Magic Enter AutoCommands";
              body = rawkOSLib.fileAsSeparatedString ./magic-enter-command.fish;
            };
          };
        };
      }
    ];

  darwin.system =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      programs.fish.enable = true;
      environment.shells = lib.mkAfter [ pkgs.fish ];

      # Allow using the Home Manager per-user fish as a login shell
      # e.g. /etc/profiles/per-user/$USER/bin/fish must be present in /etc/shells
      # Use system.primaryUser (set by users-* module) when available
      environment.etc."shells".text = lib.mkAfter (
        lib.optionalString (lib.attrsets.hasAttrByPath [ "system" "primaryUser" ] config) ''
          /etc/profiles/per-user/${config.system.primaryUser}/bin/fish
        ''
      );
    };
}
