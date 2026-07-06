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
          lib,
          ...
        }:
        {
          home-manager.users.rawkode.rawkOS.apps.ai.cliPackages.enable = false;
          home-manager.users.rawkode.rawkOS.development.python.extraTools.enable = false;
          home-manager.users.rawkode.rawkOS.apps.misc.ffmpeg.enable = false;
          home-manager.users.rawkode.rawkOS.stylix.enable = false;

          rawkOS.stylix.enable = false;
          rawkOS.development.guiTools.enable = false;
          programs.kdeconnect.enable = lib.mkForce false;
          environment.variables = {
            EDITOR = lib.mkForce "vim";
            SUDO_EDITOR = lib.mkForce "vim";
            SYSTEMD_EDITOR = lib.mkForce "vim";
            VISUAL = lib.mkForce "vim";
          };
          home-manager.users.rawkode.home.sessionVariables = {
            EDITOR = lib.mkForce "vim";
            SUDO_EDITOR = lib.mkForce "vim";
            SYSTEMD_EDITOR = lib.mkForce "vim";
            VISUAL = lib.mkForce "vim";
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
