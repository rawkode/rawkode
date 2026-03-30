{
  flake.machineManifests.p4x-parallels-nixos = {
    capabilities = [
      "foundation"
      "desktop"
      "development"
      "platform"
    ];
    disabledCapabilities = [ ];
    users = { };
  };
}
