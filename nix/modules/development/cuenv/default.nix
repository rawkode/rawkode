{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };

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
    { inputs, pkgs, ... }:
    let
      packages = inputs.cuenv.packages.${pkgs.stdenv.hostPlatform.system};
      package = packages.default or packages.cuenv;
    in
    {
      nix.settings = cuenvCache;

      home.packages = [ package ];
    };

  linux.system = _: {
    nix.settings = cuenvCache;
  };

  darwin.system = _: {
    nix.settings = cuenvCache;
  };
}
