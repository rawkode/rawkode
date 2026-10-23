# Fish shell configuration
_:
let
  mkApp = import ../../../lib/mkApp.nix;

  # Helper to disable stylix fish theming (we use our own)
  mkStylixFishDisable =
    {
      lib,
      options,
    }:
    lib.optionalAttrs (lib.attrsets.hasAttrByPath [ "stylix" "targets" "fish" ] options) {
      stylix.targets.fish.enable = lib.mkForce false;
    };
in
mkApp {
  name = "fish";

  linux.system =
    {
      lib,
      options,
      ...
    }:
    lib.mkMerge [
      (mkStylixFishDisable { inherit lib options; })
      {
        programs.fish.enable = true;
      }
    ];

  common.home =
    {
      config,
      lib,
      options,
      pkgs,
      rawkOSLib,
      ...
    }:
    lib.mkMerge [
      (mkStylixFishDisable { inherit lib options; })
      {
        # Global exports shadow legacy universal variables left by earlier
        # versions of interactiveInit.fish, without rewriting Fish's state.
        xdg.configFile."fish/conf.d/rawkos-editor.fish".text =
          lib.concatMapStringsSep "\n"
            (name: "set -gx ${name} ${lib.escapeShellArg config.home.sessionVariables.${name}}")
            [
              "EDITOR"
              "VISUAL"
              "SUDO_EDITOR"
              "SYSTEMD_EDITOR"
            ];

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
            tmp = "cd (mktemp -d)";
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
      lib,
      pkgs,
      ...
    }:
    {
      programs.fish.enable = true;
      environment.shells = lib.mkAfter [ pkgs.fish ];
    };
}
