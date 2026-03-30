{
  flake.machineManifests.p4x-desktop-nixos = {
    capabilities = [
      "foundation"
      "desktop"
      "productivity"
      "personal-comms"
      "development"
      "platform"
    ];
    disabledCapabilities = [ ];
    users = { };
  };
}
