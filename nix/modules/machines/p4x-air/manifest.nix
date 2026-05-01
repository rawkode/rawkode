{
  flake.machineManifests.p4x-air = {
    platform = "darwin";
    system = "aarch64-darwin";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "desktop"
      "productivity"
      "personal"
      "development"
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
