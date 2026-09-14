{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "multipass";

  common.home =
    { pkgs, ... }:
    {
      home.packages = [ inputs.multipass.packages.${pkgs.stdenv.hostPlatform.system}.default ];
    };

  linux.system =
    { pkgs, ... }:
    {
      # Run before 73-seat-late.rules so logind grants the active session access.
      # The keyboard is detected through metadata and needs no device ACL.
      services.udev.packages = [
        (pkgs.writeTextDir "lib/udev/rules.d/70-multipass-mx4.rules" ''
          ACTION=="add|change", SUBSYSTEM=="hidraw", KERNELS=="0005:046D:B042.*", TAG+="uaccess"
        '')
      ];
    };
}
