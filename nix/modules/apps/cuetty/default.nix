{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "cuetty";

  common.home =
    {
      inputs,
      pkgs,
      ...
    }:
    let
      packages = inputs.cuetty.packages.${pkgs.stdenv.hostPlatform.system};
      package = packages.cuetty or packages.default;
    in
    {
      home.packages = [ package ];
    };
}
