{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "sonora";

  linux.home =
    { pkgs, ... }:
    {
      nix.settings = {
        extra-substituters = [ "https://sonora.cachix.org" ];
        extra-trusted-public-keys = [
          "sonora.cachix.org-1:qbPeDsvZPbwUWHpQS5Oe0bjz5oHAVscHem+MCzwrc9Q="
        ];
      };

      home.packages = [ inputs.sonora.packages.${pkgs.stdenv.hostPlatform.system}.sonora ];
    };
}
