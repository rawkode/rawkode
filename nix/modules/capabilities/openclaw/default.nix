{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "openclaw";
  inherit (inputs.self.appBundles.openclaw) home;

  # The gateway runs as the primary user and manages Tailscale Serve itself,
  # which requires that user to be the tailscaled operator.
  nixos =
    { machine, ... }:
    {
      services.tailscale.extraSetFlags = [
        "--operator=${inputs.self.machineManifests.${machine}.primaryUser}"
      ];
    };
}
