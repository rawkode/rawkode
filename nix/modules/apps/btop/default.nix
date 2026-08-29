_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "btop";

  common.home = {
    programs.btop = {
      enable = true;
    };
  };
}
