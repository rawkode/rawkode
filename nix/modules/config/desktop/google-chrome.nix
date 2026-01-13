{
  flake.nixosModules.google-chrome =
    { pkgs, inputs, ... }:
    {
      stylix.targets.chromium.enable = false;

      # Install Google Chrome via nixpkgs
      # and Google Chrome (Dev) via browser-previews
      environment.systemPackages = [
        pkgs.google-chrome
        inputs.browser-previews.packages.${pkgs.stdenv.hostPlatform.system}.google-chrome-dev
      ];
    };

  flake.darwinModules.google-chrome =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "google-chrome" ];
      };
    };
}
