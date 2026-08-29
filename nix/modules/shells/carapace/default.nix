_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "carapace";

  common.home = _: {
    programs.carapace = {
      enable = true;

      enableFishIntegration = true;
      enableNushellIntegration = true;
    };
  };
}
