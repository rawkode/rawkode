{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };

  bundleId = "com.binarynights.ForkLift";
in
mkApp {
  name = "forklift";

  darwin = {
    home =
      { config, pkgs, ... }:
      {
        home.activation.forkliftDefaultFileManager = config.lib.dag.entryAfter [ "writeBoundary" ] ''
          if [ "$(/usr/bin/defaults read -g NSFileViewer 2>/dev/null || true)" != "${bundleId}" ]; then
            /usr/bin/defaults write -g NSFileViewer -string ${bundleId}
          fi

          launch_services_domain="com.apple.LaunchServices/com.apple.launchservices.secure"
          launch_services_plist="$HOME/Library/Preferences/$launch_services_domain.plist"
          launch_services_json="$(/usr/bin/mktemp -t forklift-launch-services.XXXXXX.json)"
          launch_services_updated_json="$(/usr/bin/mktemp -t forklift-launch-services.XXXXXX.json)"
          launch_services_updated_plist="$(/usr/bin/mktemp -t forklift-launch-services.XXXXXX.plist)"

          if [ -f "$launch_services_plist" ]; then
            /usr/bin/plutil -convert json -o "$launch_services_json" "$launch_services_plist"
          else
            /bin/echo '{"LSHandlers":[]}' > "$launch_services_json"
          fi

          ${pkgs.jq}/bin/jq --arg bundleId "${bundleId}" '
            .LSHandlers = (
              (.LSHandlers // [])
              | map(select(.LSHandlerContentType != "public.folder"))
              + [{
                "LSHandlerContentType": "public.folder",
                "LSHandlerRoleAll": $bundleId
              }]
            )
          ' "$launch_services_json" > "$launch_services_updated_json"

          /usr/bin/plutil -convert xml1 -o "$launch_services_updated_plist" "$launch_services_updated_json"
          /usr/bin/defaults import "$launch_services_domain" "$launch_services_updated_plist"
          /bin/rm -f "$launch_services_json" "$launch_services_updated_json" "$launch_services_updated_plist"
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
