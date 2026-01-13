{
  flake.nixosModules.firefox =
    { inputs, pkgs, ... }:
    {
      programs.firefox = {
        enable = true;
        package = inputs.firefox.packages.${pkgs.stdenv.hostPlatform.system}.firefox-nightly-bin;
      };
    };
}
