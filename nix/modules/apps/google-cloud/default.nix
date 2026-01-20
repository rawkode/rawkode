{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "google-cloud";

  home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        (google-cloud-sdk.withExtraComponents [ google-cloud-sdk.components.gke-gcloud-auth-plugin ])
      ];
    };

  darwin =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "gcloud-cli" ];
      };
    };
}
