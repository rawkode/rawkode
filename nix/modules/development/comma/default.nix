_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "comma";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ comma ];
    };
}
