{ inputs }:
let
  dedupe =
    items:
    builtins.foldl' (acc: item: if builtins.elem item acc then acc else acc ++ [ item ]) [ ] items;

  normalizeSelection = selection: {
    capabilities = selection.capabilities or [ ];
    disabledCapabilities = selection.disabledCapabilities or [ ];
  };

  machineManifestFor =
    machine:
    if machine == null then
      throw "Capability resolution requires a machine name"
    else if builtins.hasAttr machine inputs.self.machineManifests then
      let
        manifest = inputs.self.machineManifests.${machine};
      in
      {
        capabilities = manifest.capabilities or [ ];
        disabledCapabilities = manifest.disabledCapabilities or [ ];
        users = manifest.users or { };
      }
    else
      throw "No machine manifest found for ${machine}";

  ensureKnownCapabilities =
    capabilities:
    map (
      capability:
      if builtins.hasAttr capability inputs.self.capabilityBundles then
        capability
      else
        throw "Unknown capability '${capability}'"
    ) capabilities;

  resolveSelection =
    {
      capabilities ? [ ],
      disabledCapabilities ? [ ],
    }:
    let
      knownCapabilities = ensureKnownCapabilities capabilities;
      knownDisabledCapabilities = ensureKnownCapabilities disabledCapabilities;
    in
    builtins.filter (capability: !(builtins.elem capability knownDisabledCapabilities)) (
      dedupe knownCapabilities
    );
in
rec {
  resolveMachineCapabilityNames =
    { machine }:
    let
      manifest = machineManifestFor machine;
    in
    resolveSelection {
      inherit (manifest)
        capabilities
        disabledCapabilities
        ;
    };

  resolveUserCapabilityNames =
    {
      machine,
      username,
      defaultCapabilities ? [ ],
      disabledCapabilities ? [ ],
    }:
    let
      manifest = machineManifestFor machine;
      userSelection = normalizeSelection (manifest.users.${username} or { });
    in
    resolveSelection {
      capabilities = defaultCapabilities ++ manifest.capabilities ++ userSelection.capabilities;
      disabledCapabilities =
        disabledCapabilities ++ manifest.disabledCapabilities ++ userSelection.disabledCapabilities;
    };

  resolveUserCapabilityImports =
    {
      kind,
      machine,
      username,
      defaultCapabilities ? [ ],
      disabledCapabilities ? [ ],
    }:
    map (capability: inputs.self.capabilityBundles.${capability}.${kind}) (resolveUserCapabilityNames {
      inherit
        machine
        username
        defaultCapabilities
        disabledCapabilities
        ;
    });
}
