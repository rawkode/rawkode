_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "nushell";

  linux.system =
    { pkgs, ... }:
    {
      programs.nushell = {
        enable = true;
        package = pkgs.nushell;
      };
    };

  darwin.system =
    {
      config,
      inputs,
      lib,
      pkgs,
      ...
    }:
    let
      nuPackage = inputs.nixpkgs-stable.legacyPackages.${pkgs.stdenv.hostPlatform.system}.nushell;
    in
    {
      environment.shells = lib.mkAfter [ nuPackage ];

      # The Home Manager profile path is the shell used by the account on Darwin.
      environment.etc."shells".text = lib.mkAfter (
        lib.optionalString (lib.attrsets.hasAttrByPath [ "system" "primaryUser" ] config) ''
          /etc/profiles/per-user/${config.system.primaryUser}/bin/nu
        ''
      );

      system.activationScripts.postActivation.text = lib.mkAfter (
        lib.optionalString (lib.attrsets.hasAttrByPath [ "system" "primaryUser" ] config) ''
          desired_shell="/etc/profiles/per-user/${config.system.primaryUser}/bin/nu"
          if [ -x "$desired_shell" ]; then
            current_shell=$(dscl . -read /Users/${config.system.primaryUser} UserShell 2>/dev/null | awk '{print $2}')
            if [ "$current_shell" != "$desired_shell" ]; then
              echo "Setting default shell to Nushell for ${config.system.primaryUser}..."
              chsh -s "$desired_shell" "${config.system.primaryUser}" 2>/dev/null || true
            fi
          fi
        ''
      );
    };

  common.home =
    {
      inputs,
      isDarwin,
      lib,
      pkgs,
      stylixHome ? false,
      system,
      ...
    }:
    # Ghostty owns the palette; Stylix's hex color_config would override it.
    lib.optionalAttrs stylixHome {
      stylix.targets.nushell.enable = false;
    }
    // {
      programs.nushell = {
        enable = true;
        # Keep Darwin on the cached stable build; Linux follows the primary channel
        # so its Nushell parser supports the current FZF completions.
        package = if isDarwin then inputs.nixpkgs-stable.legacyPackages.${system}.nushell else pkgs.nushell;

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
        ''
        # Nushell skips /etc/zshenv and path_helper, so add the nix-darwin and
        # Homebrew paths that the fish login shell used to provide.
        + lib.optionalString isDarwin ''
          $env.PATH = ($env.PATH | prepend [
            $'/etc/profiles/per-user/($env.USER)/bin'
            /run/current-system/sw/bin
            /opt/homebrew/bin
            /opt/homebrew/sbin
            /usr/local/bin
          ] | uniq)
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
