_:
let
  mkApp = import ../../../lib/mkApp.nix;

  cuenvCache = {
    extra-substituters = [ "https://cuenv.cachix.org" ];
    extra-trusted-public-keys = [
      "cuenv.cachix.org-1:zPi7E3HNNHEYzsDwSMGXk0pvEeWzdrb/09B/JozulHw="
    ];
  };
in
mkApp {
  name = "cuenv";

  common.home =
    {
      config,
      inputs,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.development.cuenv;
      cuenvPkgs = inputs.cuenv.packages.${pkgs.stdenv.hostPlatform.system};
    in
    {
      options.rawkOS.development.cuenv.cuetty.enable = lib.mkEnableOption "cuetty terminal" // {
        default = true;
      };

      config = {
        nix.settings = cuenvCache;

        home.packages = [ cuenvPkgs.cuenv ] ++ lib.optionals cfg.cuetty.enable [ cuenvPkgs.cuetty ];

        xdg.configFile."cuetty/config.cue" = lib.mkIf cfg.cuetty.enable {
          source = ./cuetty.cue;
        };

        programs.fish.shellAbbrs = lib.mkIf config.programs.fish.enable {
          c = {
            expansion = "cuenv ";
            position = "command";
          };
        };

        programs.nushell.shellAliases = lib.mkIf config.programs.nushell.enable {
          c = "cuenv";
        };

        programs.nushell.settings.abbreviations =
          lib.mkIf
            (
              config.programs.nushell.enable
              && lib.versionAtLeast config.programs.nushell.package.version "0.113.0"
            )
            {
              c = "cuenv";
            };
      };
    };

  linux.system = _: {
    nix.settings = cuenvCache;
  };

  darwin.system = _: {
    nix.settings = cuenvCache;
  };
}
