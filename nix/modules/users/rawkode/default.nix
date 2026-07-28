{ inputs, lib, ... }:
let
  mkUser = import ../../../lib/mkUser.nix { inherit inputs lib; };
in
mkUser {
  username = "rawkode";
  name = "David Flanagan";
  email = "david@rawkode.dev";
  signingKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAXwFFDFPDUbAql+V8xMmFxuZe6aUUxDD2cY0Dr0X1g9";

  homeExtraConfig =
    {
      isDarwin,
      lib,
      machine ? null,
      ...
    }:
    (lib.optionalAttrs (!isDarwin) {
      rawkOS.desktop.darkman.enable = false;
    })
    // (lib.optionalAttrs (machine == "p4x-orb-nixos") {
      imports = [
        (
          { lib, ... }:
          {
            options.rawkOS.desktop.darkman.enable =
              lib.mkEnableOption "Darkman automatic light/dark theme switching";
          }
        )
      ];
    });

  nixosUserConfig = _: {
    extraGroups = [ "libvirtd" ];
  };

  enableHomeConfigurations = true;
}
