{ inputs, pkgs, ... }:

{
  home.packages = (with pkgs; [ vivaldi ]);

  programs.firefox = {
    enable = true;
    package = inputs.firefox.packages.${pkgs.system}.firefox-nightly-bin;
  };
}
