{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "capabilities-coreweave";

  home = with inputs.self.appBundles; [
    coreweave.home
  ];

  darwin =
    { lib, ... }:
    {
      imports = with inputs.self.appBundles; [
        coreweave.darwin
      ];

      rawkOS.darwin.firewall.enable = lib.mkForce false;
    };
}
