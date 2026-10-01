{
  flake.machineManifests.p4x-studio = {
    platform = "darwin";
    system = "aarch64-darwin";
    primaryUser = "rawkode";
    capabilities = [
      "foundation"
      "theming"
      "peripherals-multipass"
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
      {
        rawkOS.darwin.codeSigning.identity = "Apple Development: David Flanagan (3NU4DUDS5C)";
      }
    ];
  };
}
