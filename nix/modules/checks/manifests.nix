{ inputs, lib, ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      machineManifest = import ../../lib/machineManifest.nix { inherit lib; };

      capabilityBundles = {
        desktop = { };
        foundation = { };
        theming = { };
      };
      traits = {
        laptop = { };
      };
      validManifest = {
        platform = "nixos";
        system = "x86_64-linux";
        primaryUser = "alice";
        users.alice = { };
        capabilities = [ "foundation" ];
        disabledCapabilities = [ ];
        traits = [ "laptop" ];
        modules = [ ];
      };

      validates =
        manifest:
        (builtins.tryEval (
          builtins.deepSeq (machineManifest.validate {
            inherit capabilityBundles manifest traits;
            machine = "fixture";
          }) true
        )).success;

      expectedHomeConfigurations = lib.sort builtins.lessThan (
        lib.flatten (
          lib.mapAttrsToList (
            machine: manifest: map (username: "${username}@${machine}") (builtins.attrNames manifest.users)
          ) inputs.self.machineManifests
        )
      );
      actualHomeConfigurations = lib.sort builtins.lessThan (
        builtins.attrNames inputs.self.homeConfigurations
      );

      contract =
        assert lib.assertMsg (validates validManifest) "A valid machine manifest must pass validation";
        assert lib.assertMsg (
          !(validates (validManifest // { users = { }; }))
        ) "A machine manifest without users must fail validation";
        assert lib.assertMsg (
          !(validates (validManifest // { primaryUser = "bob"; }))
        ) "A machine manifest whose primary user is undeclared must fail validation";
        assert lib.assertMsg (
          !(validates (validManifest // { system = "aarch64-darwin"; }))
        ) "A machine manifest with a platform/system mismatch must fail validation";
        assert lib.assertMsg (
          !(validates (validManifest // { capabilities = [ "unknown" ]; }))
        ) "A machine manifest with an unknown capability must fail validation";
        assert lib.assertMsg (
          !(validates (validManifest // { disabledCapabilities = [ "unknown" ]; }))
        ) "A machine manifest with an unknown disabled capability must fail validation";
        assert lib.assertMsg (
          !(validates (validManifest // { traits = [ "unknown" ]; }))
        ) "A machine manifest with an unknown trait must fail validation";
        assert lib.assertMsg (
          !(validates (
            validManifest
            // {
              users.alice.capabilities = [ "unknown" ];
            }
          ))
        ) "Unknown user capabilities must fail manifest validation";
        assert lib.assertMsg (
          !(validates (
            validManifest
            // {
              capabilities = [
                "foundation"
                "desktop"
              ];
            }
          ))
        ) "Desktop requires explicit machine theming";
        assert lib.assertMsg (
          !(validates (
            validManifest
            // {
              users.alice.capabilities = [ "theming" ];
            }
          ))
        ) "NixOS user theming requires system integration";
        assert lib.assertMsg (validates (
          validManifest
          // {
            capabilities = [
              "foundation"
              "desktop"
              "theming"
            ];
          }
        )) "Explicit desktop and theming composition must validate";
        assert lib.assertMsg (
          expectedHomeConfigurations == actualHomeConfigurations
        ) "Home Manager outputs must exactly match manifest-declared user/machine pairs";
        true;
    in
    {
      checks.manifest-contract = pkgs.runCommand "rawkos-manifest-contract" { inherit contract; } ''
        touch "$out"
      '';
    };
}
