{
  flake.machineManifests.p4x-orb-nixos = {
    platform = "nixos";
    system = "aarch64-linux";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "development"
    ];
    disabledCapabilities = [ ];
    traits = [
      "orbstack-vm"
    ];
    users.rawkode = { };
    modules = [
      (
        {
          inputs,
          lib,
          pkgs,
          ...
        }:
        {
          # The rawkode home config disables darkman on all Linux machines, but
          # the `rawkOS.desktop.darkman` option is only declared by the desktop
          # capability. This is a CLI-only machine, so import the (disabled)
          # darkman home module to declare the option without pulling desktop.
          home-manager.users.rawkode.imports = [ inputs.self.homeModules.darkman ];
          home-manager.users.rawkode.rawkOS.development.python.extraTools.enable = false;
          home-manager.users.rawkode.rawkOS.apps.misc.ffmpeg.enable = false;
          home-manager.users.rawkode.rawkOS.apps.zed.enable = false;

          rawkOS.development.guiTools.enable = false;
          programs.kdeconnect.enable = lib.mkForce false;
          stylix.fonts.emoji = {
            package = lib.mkForce pkgs.dejavu_fonts;
            name = lib.mkForce "DejaVu Sans";
          };
          services = {
            fwupd.enable = lib.mkForce false;
            hardware.bolt.enable = lib.mkForce false;
            libinput.enable = lib.mkForce false;
            pcscd.enable = lib.mkForce false;
            printing.enable = lib.mkForce false;
            smartd.enable = lib.mkForce false;
          };
        }
      )
    ];
  };
}
