{
  flake.machineManifests.p4x-mbp = {
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
      "tailnet"
    ];
    disabledCapabilities = [ ];
    traits = [ ];
    users.rawkode = { };
    modules = [
      {
        rawkOS.darwin.firewall = {
          enable = true;
          stealthMode = true;
          allowSigned = true;
          allowSignedApp = true;
        };
      }
    ];
  };
}
