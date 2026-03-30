{ inputs, lib, ... }:
let
  mkUser = import ../../../lib/mkUser.nix { inherit inputs lib; };
  machineSystems = import ../../../lib/machineSystems.nix;
in
mkUser {
  username = "rawkode";
  name = "David Flanagan";
  email = "david@rawkode.dev";
  signingKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAXwFFDFPDUbAql+V8xMmFxuZe6aUUxDD2cY0Dr0X1g9";
  inherit machineSystems;

  homeExtraConfig =
    { lib, isDarwin, ... }:
    lib.optionalAttrs (!isDarwin) {
      rawkOS.desktop.darkman.enable = false;
    };

  nixosUserConfig = _: {
    extraGroups = [ "libvirtd" ];
  };

  enableHomeConfigurations = true;
  machinesDir = ../../machines;
}
