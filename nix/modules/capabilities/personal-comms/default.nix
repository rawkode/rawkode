{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "personal-comms";

  home = with inputs.self.appBundles; [
    discord.home
  ];

  darwin = with inputs.self.appBundles; [
    discord.darwin
  ];
}
