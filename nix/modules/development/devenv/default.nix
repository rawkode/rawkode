{ lib, ... }:
  let
    mkApp = import ../../../lib/mkApp.nix { inherit lib; };

  devenvCache = {
    extra-substituters = [ "https://devenv.cachix.org" ];
    extra-trusted-public-keys = [
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
    ];
  };
in
mkApp {
  name = "devenv";

  common.home =
    { pkgs, ... }:
    {
      nix.settings = devenvCache;

      home.packages = with pkgs; [ devenv ];
    };

  linux.system = _: {
    nix.settings = devenvCache;
  };

  darwin.system = _: {
    nix.settings = devenvCache;
  };
}
