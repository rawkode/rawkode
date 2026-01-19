{
  flake.homeModules.clickup =
    { lib, pkgs, ... }:
    {
      home.packages = lib.optionals pkgs.stdenv.isx86_64 (
        with pkgs;
        [
          clickup
        ]
      );
    };
}
