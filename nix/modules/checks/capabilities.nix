{ lib, ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      # Stub `inputs.self` so resolution can be exercised against fixtures
      # without depending on the real machine manifests.
      resolver = import ../../lib/capabilityResolver.nix {
        inputs.self = {
          capabilityBundles = {
            foundation = {
              home = "foundation-home";
              nixos = "foundation-nixos";
              darwin = "foundation-darwin";
            };
            desktop = {
              home = "desktop-home";
              nixos = "desktop-nixos";
              darwin = "desktop-darwin";
            };
            extra = {
              home = "extra-home";
              nixos = "extra-nixos";
              darwin = "extra-darwin";
            };
          };
          machineManifests = {
            box = {
              capabilities = [
                "foundation"
                "desktop"
              ];
              disabledCapabilities = [ "desktop" ];
              users = {
                alice = {
                  capabilities = [ "extra" ];
                  disabledCapabilities = [ ];
                };
                bob = { };
                carol = {
                  capabilities = [ "unknown" ];
                  disabledCapabilities = [ ];
                };
              };
            };
          };
        };
      };

      throws = expr: !(builtins.tryEval (builtins.deepSeq expr true)).success;

      resolves = resolver.resolveMachineCapabilityNames;
      resolvesUser = resolver.resolveUserCapabilityNames;
      importsUser = resolver.resolveUserCapabilityImports;

      contract =
        # Machine capabilities resolve, dedupe, and honour disable precedence.
        assert lib.assertMsg (
          resolves { machine = "box"; } == [ "foundation" ]
        ) "Machine capabilities must resolve with disabled capabilities removed";
        # User selection inherits machine capabilities and adds user ones.
        assert lib.assertMsg (
          resolvesUser {
            machine = "box";
            username = "alice";
          } == [
            "foundation"
            "extra"
          ]
        ) "User capabilities must inherit machine capabilities and add user selections";
        assert lib.assertMsg (
          resolvesUser {
            machine = "box";
            username = "bob";
          } == [ "foundation" ]
        ) "A user with no explicit selection must inherit machine capabilities";
        # Duplicate capabilities are removed.
        assert lib.assertMsg (
          resolvesUser {
            machine = "box";
            username = "alice";
            defaultCapabilities = [
              "foundation"
              "foundation"
            ];
          } == [
            "foundation"
            "extra"
          ]
        ) "Duplicate capabilities must be removed";
        # Imports are mapped to the requested module kind.
        assert lib.assertMsg (
          importsUser {
            kind = "home";
            machine = "box";
            username = "alice";
          } == [
            "foundation-home"
            "extra-home"
          ]
        ) "User capability imports must map to the requested module kind";
        # Unknown capabilities fail, from every source.
        assert lib.assertMsg (throws (resolves {
          machine = "missing";
        })) "An unknown machine must fail to resolve";
        assert lib.assertMsg (throws (resolvesUser {
          machine = "box";
          username = "carol";
        })) "An unknown capability in a user selection must fail to resolve";
        true;
    in
    {
      checks.capability-resolver = pkgs.runCommand "rawkos-capability-resolver" { inherit contract; } ''
        touch "$out"
      '';
    };
}
