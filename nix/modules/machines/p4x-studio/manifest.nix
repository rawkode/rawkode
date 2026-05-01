{
  flake.machineManifests.p4x-studio = {
    platform = "darwin";
    system = "aarch64-darwin";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "desktop"
      "productivity"
      "personal-comms"
      "personal"
      "development"
      "platform"
      "extras"
      "tailnet"
    ];
    disabledCapabilities = [ ];
    traits = [ ];
    users.rawkode = { };
    modules = [ ];
  };
}
