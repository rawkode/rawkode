{ inputs, pkgs, ... }:
{
  home.packages = [
    inputs.gauntlet.packages."${pkgs.stdenv.hostPlatform.system}".default
  ];
}
