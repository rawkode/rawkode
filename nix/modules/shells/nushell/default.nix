{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "nushell";

  common.home =
    {
      inputs,
      system,
      ...
    }:
    {
      programs.nushell = {
        enable = true;
        # Use stable nixpkgs — unstable nushell has no binary cache on aarch64-darwin
        # (Hydra build was dropped from evaluation, likely a build failure)
        package = inputs.nixpkgs-stable.legacyPackages.${system}.nushell;

        configFile.source = ./config.nu;

        shellAliases = {
          ai = ''GEMINI_API_KEY="op://Private/Google Gemini/password" op run --account my.1password.eu -- aichat'';
          ghb = "cd ~/Code/src/github.com";
          tmp = "cd (mktemp -d)";
        };

        environmentVariables = {
          OP_PLUGIN_ALIASES_SOURCED = "1";
        };

        # These are set in extraEnv (raw, evaluated nushell) rather than
        # environmentVariables, because home-manager emits the latter as quoted
        # string literals via load-env — so any value that needs evaluation
        # (interpolation, $env.PATH manipulation) would be stored
        # verbatim instead of run. NIX_LINK must precede its users below.
        extraEnv = ''
          $env.NIX_LINK = "/nix/var/nix/profiles/default"
          $env.NIX_PROFILES = $"/nix/var/nix/profiles/default ($env.NIX_LINK)"
          $env.PATH = ($env.PATH | split row (char esep) | prepend $'($env.HOME)/.nix-profile/bin' | append $'($env.NIX_LINK)/bin')

          # Nushell doesn't increment SHLVL for nested shells (nushell/nushell#14384),
          # so do it manually here to keep the starship shlvl prompt accurate.
          $env.SHLVL = (($env | get -o SHLVL | default 0 | into int) + 1)
        '';

        extraConfig = ''
          $env.config = ($env.config? | default {})
          $env.config.hooks = ($env.config.hooks? | default {})
          $env.config.hooks.pre_execution = (
            $env.config.hooks.pre_execution?
            | default []
            | append {||
              let cmd = (commandline | str trim)

              if $cmd == "" {
                run-external eza
                if (do { git rev-parse --is-inside-work-tree } | complete).exit_code == 0 {
                  run-external "git" "status"
                }
              }
            }
          )
        '';
      };
    };
}
