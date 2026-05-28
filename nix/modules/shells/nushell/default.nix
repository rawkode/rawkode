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
      isDarwin,
      ...
    }:
    let
      onePasswordSock =
        if isDarwin then
          "($env.HOME | path join 'Library' 'Group Containers' '2BUA8C4S2C.com.1password' 't' 'agent.sock')"
        else
          "($env.HOME | path join '.1password' 'agent.sock')";
    in
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
          NIX_LINK = ''"/nix/var/nix/profiles/default"'';
          NIX_PROFILES = ''"/nix/var/nix/profiles/default ($env.NIX_LINK)"'';
          OP_PLUGIN_ALIASES_SOURCED = "1";
          PATH = "($env.PATH | split row (char esep) | prepend $'($env.HOME)/.nix-profile/bin' | append $'($env.NIX_LINK)/bin')";
          SSH_AUTH_SOCK = onePasswordSock;
        };

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
