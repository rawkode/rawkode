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
        { inputs, ... }:
        {
          # The rawkode home config disables darkman on all Linux machines, but
          # the `rawkOS.desktop.darkman` option is only declared by the desktop
          # capability. This is a CLI-only machine, so import the (disabled)
          # darkman home module to declare the option without pulling desktop.
          home-manager.users.rawkode.imports = [ inputs.self.homeModules.darkman ];
        }
      )
    ];
  };
}
