{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "openclaw";
  inherit (inputs.self.appBundles.openclaw) home;

  # The gateway listens on the NetBird address; only NetBird peers may reach it.
  nixos =
    { config, ... }:
    {
      networking.firewall.interfaces.${config.services.netbird.clients.default.interface}.allowedTCPPorts =
        [ 18789 ];
    };
}
