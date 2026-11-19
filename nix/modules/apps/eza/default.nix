_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "eza";

  common.home = _: {
    programs = {
      eza = {
        enable = true;
        enableFishIntegration = true;

        colors = "always";
        git = true;
        icons = "always";

        extraOptions = [
          "--time-style"
          "relative"
          "--group-directories-first"
          "--no-quotes"
        ];
      };
    };
  };
}
