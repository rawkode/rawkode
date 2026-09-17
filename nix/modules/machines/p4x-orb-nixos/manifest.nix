{
  flake.machineManifests.p4x-orb-nixos = {
    platform = "nixos";
    system = "aarch64-linux";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "peripherals-multipass"
      "development"
    ];
    disabledCapabilities = [ ];
    traits = [
      "orbstack-vm"
    ];
    users.rawkode = {
      editor = "vim";
      modules = [
        {
          rawkOS.apps.ai.cliPackages.enable = false;
          rawkOS.development.python.extraTools.enable = false;
          rawkOS.apps.misc.ffmpeg.enable = false;
        }
      ];
    };
    modules = [ { rawkOS.development.guiTools.enable = false; } ];
  };
}
