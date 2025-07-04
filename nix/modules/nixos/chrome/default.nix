{ pkgs, inputs, ... }:
{
  environment.systemPackages = with inputs.browser-previews.packages.${pkgs.system}; [
    google-chrome-dev # Dev Release
  ];
}
