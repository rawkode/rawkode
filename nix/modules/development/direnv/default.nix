_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "direnv";

  common.home = _: {
    programs.direnv = {
      enable = true;
      nix-direnv.enable = true;
    };
  };
}
