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
    in
    if declaredUsers == [ ] then
      throw "Machine manifest '${machine}' must declare at least one user"
    else if !(builtins.hasAttr manifest.primaryUser manifest.users) then
      throw "Primary user '${manifest.primaryUser}' is not declared by machine manifest '${machine}'"
    else if !(lib.hasSuffix expectedSuffix manifest.system) then
      throw "Machine manifest '${machine}' uses platform '${manifest.platform}' with incompatible system '${manifest.system}'"
    else
      builtins.deepSeq knownCapabilities (builtins.deepSeq knownTraits manifest);

  machinesForUser =
    {
      manifests,
      username,
    }:
    lib.filterAttrs (_machine: manifest: builtins.hasAttr username manifest.users) manifests;
}
