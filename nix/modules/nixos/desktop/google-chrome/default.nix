{ pkgs, inputs, ... }: {
  environment.systemPackages =
    [ inputs.browser-previews.packages.${pkgs.system}.google-chrome-dev ];
}
