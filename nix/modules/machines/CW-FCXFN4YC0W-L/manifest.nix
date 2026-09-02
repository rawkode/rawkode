{
  flake.machineManifests.CW-FCXFN4YC0W-L = {
    platform = "darwin";
    system = "aarch64-darwin";
    primaryUser = "dflanagan";
    capabilities = [
      "foundation"
      "desktop"
      "productivity"
      "development"
      "capabilities-coreweave"
    ];
    disabledCapabilities = [ ];
    traits = [ ];
    users.dflanagan = { };
    modules = [
      { rawkOS.apps.zoom.enable = false; }
    ];
  };
}
