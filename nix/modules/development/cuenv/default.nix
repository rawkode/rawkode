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
    {
      nix.settings = cuenvCache;

      home.packages = with inputs.cuenv.packages.${pkgs.stdenv.hostPlatform.system}; [
        cuenv
        cuetty
      ];

      xdg.configFile."cuetty/config.cue".source = ./cuetty.cue;

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

  linux.system = _: {
    nix.settings = cuenvCache;
  };

  darwin.system = _: {
    nix.settings = cuenvCache;
  };
}
