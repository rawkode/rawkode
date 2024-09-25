{ pkgs, inputs, ... }:

{
  system.environmentPackages = [
    inputs.browser-previews.packages.${pkgs.system}.google-chrome-dev
  ];
}
