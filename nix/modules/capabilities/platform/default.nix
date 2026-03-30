{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "platform";

  home = with inputs.self.appBundles; [
    google-cloud.home
    kubernetes.home
    podman.home
  ];

  darwin = with inputs.self.appBundles; [
    google-cloud.darwin
    kubernetes.darwin
    podman.darwin
  ];

  nixos = with inputs.self.appBundles; [
    google-cloud.nixos
    kubernetes.nixos
    podman.nixos
  ];
}
