{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  # Prefixed to avoid colliding with the "coreweave" app bundle
  # (modules/coreweave/mod.nix) in flake.{home,nixos,darwin}Modules.
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
