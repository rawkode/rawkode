{
  flake.machineManifests.p4x-laptop-nixos = {
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
