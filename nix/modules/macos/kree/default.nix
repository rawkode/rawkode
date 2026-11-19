_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "kree";

  darwin.system =
    { inputs, pkgs, ... }:
    {
      # Installed into ~/Applications and signed with the host's stable
      # identity by the shared macos-code-signing module. macOS ties the
      # Accessibility grant to the code signature, not the path, so an ad-hoc
      # rebuild would otherwise require re-granting it every time.
      rawkOS.darwin.codeSigning.apps."Kree.app".bundle = "${
        inputs.kree.packages.${pkgs.stdenv.hostPlatform.system}.default
      }/Applications/Kree.app";
    };
}
