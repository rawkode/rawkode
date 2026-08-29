_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "deno";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [ deno ];
      home.sessionPath = [ "$HOME/.deno/bin" ];
    };
}
