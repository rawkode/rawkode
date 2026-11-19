{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
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
    teleport.darwin
  ];
}
