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

          # App/module-specific caches are configured in their own modules.
          substituters = [ "https://cache.nixos.org/" ];
          trusted-public-keys = [
            "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
          ];
        };
      };
    };

  flake.darwinModules.nix = {
    nix.settings = {
      # App/module-specific caches are configured in their own modules.
      substituters = [ "https://cache.nixos.org/" ];
      trusted-public-keys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
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
