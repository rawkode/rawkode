{
  flake.machineManifests.p4x-framework-nixos = {
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
