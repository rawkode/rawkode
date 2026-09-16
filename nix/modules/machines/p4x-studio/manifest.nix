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
      "vpn"
    ];
    disabledCapabilities = [ ];
    traits = [ ];
    users.rawkode = { };
    modules = [
      { rawkOS.apps.multipass.signingIdentity = "Apple Development: David Flanagan (3NU4DUDS5C)"; }
    ];
  };
}
