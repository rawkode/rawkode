{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "peripherals-multipass";
  inherit (inputs.self.appBundles.multipass) home nixos darwin;
}
