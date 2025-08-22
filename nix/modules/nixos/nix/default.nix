{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.rawkOS.user;
in
{
  imports = [ (lib.snowfall.fs.get-file "modules/shared/stylix/default.nix") ];

  home-manager = {
    useUserPackages = true;
    backupFileExtension = "backup";

    extraSpecialArgs = { inherit cfg; };
  };

  environment.systemPackages = with pkgs; [
    nix-forecast
    nixd
    nixfmt-rfc-style
  ];

  programs.nh = {
    enable = true;
    clean.enable = true;
    clean.extraArgs = "--keep-since 7d --keep 3";
  };

  nix = {
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

      substituters = [
        "https://nix-community.cachix.org"
        "https://cache.nixos.org/"
      ];
      trusted-public-keys = [
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
    };
  };
}
