{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "eloquawk";

  linux.home = {
    imports = [ inputs.eloquawk.homeModules.default ];
    programs.eloquawk.enable = true;
  };
}
