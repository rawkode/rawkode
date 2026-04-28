{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };

  bundleId = "com.binarynights.ForkLift";
in
mkApp {
  name = "forklift";

  darwin = {
    home =
      { config, ... }:
      {
        home.activation.forkliftDefaultFileManager = config.lib.dag.entryAfter [ "writeBoundary" ] ''
          /usr/bin/defaults write -g NSFileViewer -string ${bundleId}
          /usr/bin/defaults write com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers -array-add '{LSHandlerContentType="public.folder";LSHandlerRoleAll="${bundleId}";}'
        '';
      };

    system =
      { lib, ... }:
      {
        homebrew = {
          enable = lib.mkDefault true;
          casks = [ "forklift" ];
        };
      };
  };
}
