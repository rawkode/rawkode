{
  flake.nixosModules.nix =
    {
      config,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.user;
    in
    {

      environment.systemPackages = with pkgs; [
        nix-forecast
        nixd
        nixfmt
      ];

      programs.nh = {
        enable = true;
        clean.enable = true;
        clean.extraArgs = "--keep-since 7d --keep 3";
      };

      nix = {
        optimise.automatic = true;
        gc.automatic = false; # Disabled in favor of programs.nh.clean

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
            "https://cache.nixos.org/"
            "https://nix-community.cachix.org"
            "https://devenv.cachix.org"
            "https://ghostty.cachix.org/"
            "https://vicinae.cachix.org/"
            "https://wezterm.cachix.org"
          ];
          trusted-public-keys = [
            "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
            "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
            "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
            "ghostty.cachix.org-1:QB389yTa6gTyneehvqG58y0WnHjQOqgnA+wBnpWWxns="
            "vicinae.cachix.org-1:1kDrfienkGHPYbkpNj1mWTr7Fm1+zcenzgTizIcI3oc="
            "wezterm.cachix.org-1:kAbLYJwT0CRG4CC6AI3qgC/YPpkUWDfH5CPICZ9GQK0="
          ];
        };
      };
    };

  flake.darwinModules.nix = {
    nix.settings = {
      substituters = [
        "https://cache.nixos.org/"
        "https://nix-community.cachix.org"
        "https://devenv.cachix.org"
        "https://ghostty.cachix.org/"
        "https://wezterm.cachix.org"
      ];
      trusted-public-keys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
        "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
        "ghostty.cachix.org-1:QB389yTa6gTyneehvqG58y0WnHjQOqgnA+wBnpWWxns="
        "wezterm.cachix.org-1:kAbLYJwT0CRG4CC6AI3qgC/YPpkUWDfH5CPICZ9GQK0="
      ];
    };
  };

  flake.homeModules.nix-home =
    { lib, pkgs, ... }:
    {
      nix = {
        package = lib.mkDefault pkgs.nix;
        settings = {
          experimental-features = [
            "nix-command"
            "flakes"
          ];
        };
      };

      home.packages = with pkgs; [
        nixd
      ];

      programs.fish.functions = {
        nixpkgs-hash-git = {
          description = "Get a nixpkgs hash for a Git revision";
          argumentNames = [
            "repoUrl"
            "revision"
          ];
          body = ''
            nix-shell -p nix-prefetch-git jq --run "nix hash convert sha256:\$(nix-prefetch-git --url $repoUrl --quiet --rev $revision | jq -r '.sha256')"
          '';
        };
      };
    };
}
