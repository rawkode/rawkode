{ config, pkgs, ... }:
let
  cfg = config.rawkOS.user;
in
{
  nix = {
    package = pkgs.nixVersions.nix_2_23;

    gc = {
      automatic = true;
      dates = "daily";
      options = "--delete-older-than 7d";
    };

    optimise.automatic = true;

    settings = {
      trusted-users = [ cfg.username ];
      auto-optimise-store = true;
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      warn-dirty = false;
      keep-derivations = true;
      keep-outputs = true;

      substituters = [ "https://cache.nixos.org" ];

      trusted-public-keys = [ "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=" ];
    };
  };
}
