{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "multipass";

  linux.home =
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

  darwin.system =
    { pkgs, ... }:
    {
      # Installed into ~/Applications and signed with the host's stable
      # identity by the shared macos-code-signing module, so Input Monitoring,
      # Local Network and keychain grants survive rebuilds. The engine is a
      # separate Mach-O inside the bundle and is signed first.
      rawkOS.darwin.codeSigning.apps."Multipass.app" = {
        bundle = "${inputs.multipass.packages.${pkgs.stdenv.hostPlatform.system}.default}/Applications/Multipass.app";
        executables = [ "Contents/MacOS/multipass-engine" ];
      };
    };
}
