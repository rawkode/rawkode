{ inputs, lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "firefox-developer-edition";

  linux.system =
    { lib, pkgs, ... }:
    let
      inherit (pkgs.stdenv.hostPlatform) system;
      firefoxPackage = pkgs.firefox-devedition;
      firefoxSupported = lib.meta.availableOn pkgs.stdenv.hostPlatform firefoxPackage;

      browserPreviewNames = [
        "firefox-developer-edition"
        "firefox-devedition"
      ];

      browserPreviewName = lib.findFirst (
        name:
        lib.hasAttrByPath [
          system
          name
        ] inputs.browser-previews.packages
      ) null browserPreviewNames;

      browserPreviewPackage =
        if browserPreviewName == null then
          null
        else
          inputs.browser-previews.packages.${system}.${browserPreviewName};
    in
    {
      # Prefer nixpkgs and only fall back to browser-previews when needed.
      environment.systemPackages =
        lib.optionals firefoxSupported [ firefoxPackage ]
        ++ lib.optional (!firefoxSupported && browserPreviewPackage != null) browserPreviewPackage;
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "firefox@developer-edition" ];
      };
    };
}
