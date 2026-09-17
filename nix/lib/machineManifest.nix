{ lib }:
let
  ensureKnown =
    {
      kind,
      known,
      machine,
      selected,
    }:
    map (
      name:
      if builtins.hasAttr name known then
        name
      else
        throw "Unknown ${kind} '${name}' in machine manifest '${machine}'"
    ) selected;

  expectedPlatformSuffix = {
    darwin = "-darwin";
    nixos = "-linux";
  };
in
{
  validate =
    {
      capabilityBundles,
      machine,
      manifest,
      traits,
    }:
    let
      declaredUsers = builtins.attrNames manifest.users;
      expectedSuffix = expectedPlatformSuffix.${manifest.platform};
      knownCapabilities = ensureKnown {
        kind = "capability";
        known = capabilityBundles;
        inherit machine;
        selected = manifest.capabilities ++ manifest.disabledCapabilities;
      };
      knownTraits = ensureKnown {
        kind = "trait";
        known = traits;
        inherit machine;
        selected = manifest.traits;
      };
      enabled =
        selection:
        lib.subtractLists (selection.disabledCapabilities or [ ]) (selection.capabilities or [ ]);
      machineCapabilities = enabled manifest;
      userContracts = lib.mapAttrsToList (
        username: selection:
        let
          known = ensureKnown {
            kind = "user capability";
            known = capabilityBundles;
            inherit machine;
            selected = (selection.capabilities or [ ]) ++ (selection.disabledCapabilities or [ ]);
          };
          userCapabilities = enabled {
            capabilities = manifest.capabilities ++ (selection.capabilities or [ ]);
            disabledCapabilities = manifest.disabledCapabilities ++ (selection.disabledCapabilities or [ ]);
          };
          missingSystemCapabilities =
            builtins.filter
              (
                capability:
                builtins.elem capability userCapabilities && !(builtins.elem capability machineCapabilities)
              )
              [
                "desktop"
                "theming"
              ];
        in
        builtins.deepSeq known (
          if manifest.platform == "nixos" && missingSystemCapabilities != [ ] then
            throw "User '${username}' on '${machine}' requires machine-level capabilities: ${lib.concatStringsSep ", " missingSystemCapabilities}"
          else if builtins.elem "desktop" userCapabilities && !(builtins.elem "theming" userCapabilities) then
            throw "Desktop user '${username}' on '${machine}' requires the theming capability"
          else
            true
        )
      ) manifest.users;
    in
    if declaredUsers == [ ] then
      throw "Machine manifest '${machine}' must declare at least one user"
    else if !(builtins.hasAttr manifest.primaryUser manifest.users) then
      throw "Primary user '${manifest.primaryUser}' is not declared by machine manifest '${machine}'"
    else if !(lib.hasSuffix expectedSuffix manifest.system) then
      throw "Machine manifest '${machine}' uses platform '${manifest.platform}' with incompatible system '${manifest.system}'"
    else if
      builtins.elem "desktop" machineCapabilities && !(builtins.elem "theming" machineCapabilities)
    then
      throw "Desktop machine '${machine}' requires the theming capability"
    else
      builtins.deepSeq [ knownCapabilities knownTraits userContracts ] manifest;

  machinesForUser =
    {
      manifests,
      username,
    }:
    lib.filterAttrs (_machine: manifest: builtins.hasAttr username manifest.users) manifests;
}
