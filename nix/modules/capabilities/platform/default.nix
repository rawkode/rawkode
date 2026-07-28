{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "platform";

  home = with inputs.self.appBundles; [
    doggo.home
    google-cloud.home
    kubernetes.home
    podman.home
    teleport.home
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
