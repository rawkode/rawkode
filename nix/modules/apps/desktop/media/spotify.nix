{
  flake.homeModules.spotify =
    { lib, pkgs, ... }:
    {
      home.packages = lib.optionals (lib.meta.availableOn pkgs.stdenv.hostPlatform pkgs.spotify) [
        pkgs.spotify
      ];
    };
}
