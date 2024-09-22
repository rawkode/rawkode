{ pkgs, inputs, ... }:

{
  home.packages = [
    inputs.browser-previews.packages.${pkgs.system}.google-chrome-dev
  ];
}
