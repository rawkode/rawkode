{ inputs, pkgs, ... }:

{
  home.packages = (
    with pkgs;
    [
      microsoft-edge-dev
      vivaldi
    ]
  );

#  programs.firefox = {
#    enable = true;
#    package = inputs.firefox.packages.${pkgs.system}.firefox-nightly-bin;
#  };
}
