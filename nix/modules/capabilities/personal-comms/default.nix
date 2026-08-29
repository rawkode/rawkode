{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
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
