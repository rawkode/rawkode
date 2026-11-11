{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "antarctical";

  linux.home = {
    imports = [ inputs.antarctical.homeModules.default ];

    programs.antarctical = {
      enable = true;
      service.enable = true;
    };
  };
}
