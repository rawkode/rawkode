{ inputs, lib }:
let
  capabilityResolver = import ./capabilityResolver.nix { inherit inputs lib; };

  normalizeTrait =
    trait:
    if builtins.isList trait then
      {
        nixos = trait;
        darwin = [ ];
      }
    else
      trait;

  ensureKnownTraits =
    { traits, selected }:
    map (
      trait: if builtins.hasAttr trait traits then trait else throw "Unknown machine trait '${trait}'"
    ) selected;

  traitImportsFor =
    {
      kind,
      traits,
      selected,
    }:
    lib.flatten (
      map
        (
          trait:
          let
            value = normalizeTrait traits.${trait};
          in
          value.${kind} or [ ]
        )
        (ensureKnownTraits {
          inherit traits;
          inherit selected;
        })
    );

  userImportsFor =
    {
      kind,
      users,
    }:
    map (username: inputs.self."${kind}Modules"."users-${username}") users;

  localModulesFor = manifest: manifest.modules or [ ];

  mkNetworkingModule =
    {
      platform,
      machine,
    }:
    if platform == "darwin" then
      {
        networking = {
          hostName = machine;
          localHostName = machine;
          computerName = machine;
        };
      }
    else
      {
        networking.hostName = machine;
      };

  usersFor =
    manifest:
    if manifest ? users && manifest.users != { } then
      builtins.attrNames manifest.users
    else if manifest ? primaryUser then
      [ manifest.primaryUser ]
    else
      throw "Machine manifest requires users or primaryUser";

  commonSpecialArgs =
    {
      machine,
    }:
    {
      inherit inputs machine;
    };

  mkNixosConfiguration =
    {
      machine,
      manifest,
      traits,
    }:
    inputs.nixpkgs.lib.nixosSystem {
      inherit (manifest) system;
      modules =
        traitImportsFor {
          kind = "nixos";
          inherit traits;
          selected = manifest.traits or [ ];
        }
        ++ capabilityResolver.resolveMachineCapabilityImports {
          kind = "nixos";
          inherit machine;
        }
        ++ userImportsFor {
          kind = "nixos";
          users = usersFor manifest;
        }
        ++ [
          (mkNetworkingModule {
            platform = "nixos";
            inherit machine;
          })
        ]
        ++ localModulesFor manifest;
      specialArgs = commonSpecialArgs { inherit machine; };
    };

  mkDarwinConfiguration =
    {
      machine,
      manifest,
      traits,
    }:
    inputs.nix-darwin.lib.darwinSystem {
      inherit (manifest) system;
      modules =
        traitImportsFor {
          kind = "darwin";
          inherit traits;
          selected = manifest.traits or [ ];
        }
        ++ capabilityResolver.resolveMachineCapabilityImports {
          kind = "darwin";
          inherit machine;
        }
        ++ userImportsFor {
          kind = "darwin";
          users = usersFor manifest;
        }
        ++ [
          (mkNetworkingModule {
            platform = "darwin";
            inherit machine;
          })
        ]
        ++ localModulesFor manifest;
      specialArgs = commonSpecialArgs { inherit machine; };
    };

  mkConfiguration =
    args@{ manifest, ... }:
    if manifest.platform == "nixos" then
      mkNixosConfiguration args
    else if manifest.platform == "darwin" then
      mkDarwinConfiguration args
    else
      throw "Unknown machine platform '${manifest.platform}'";

  configsForPlatform =
    {
      platform,
      manifests,
      traits,
    }:
    builtins.listToAttrs (
      map
        (
          machine:
          let
            manifest = manifests.${machine};
          in
          {
            name = machine;
            value = mkConfiguration {
              inherit
                machine
                manifest
                traits
                ;
            };
          }
        )
        (
          builtins.filter (machine: manifests.${machine}.platform == platform) (builtins.attrNames manifests)
        )
    );

  darwinPackageAliases =
    {
      darwinConfigurations,
      manifests,
    }:
    let
      darwinMachines = builtins.attrNames darwinConfigurations;

      systemAliases = builtins.listToAttrs (
        map (machine: {
          name = machine;
          value = darwinConfigurations.${machine}.system;
        }) darwinMachines
      );

      activationAliases = builtins.listToAttrs (
        lib.flatten (
          map (
            machine:
            map (
              username:
              let
                homeName = "${username}@${machine}";
              in
              lib.optional (builtins.hasAttr homeName inputs.self.homeConfigurations) {
                name = homeName;
                value = inputs.self.homeConfigurations.${homeName}.activationPackage;
              }
            ) (usersFor manifests.${machine})
          ) darwinMachines
        )
      );
    in
    systemAliases // activationAliases;
in
{
  mkMachines =
    {
      manifests,
      traits ? { },
    }:
    let
      nixosConfigurations = configsForPlatform {
        platform = "nixos";
        inherit manifests traits;
      };
      darwinConfigurations = configsForPlatform {
        platform = "darwin";
        inherit manifests traits;
      };
      darwinPackages = darwinPackageAliases {
        inherit darwinConfigurations manifests;
      };
    in
    {
      inherit
        nixosConfigurations
        darwinConfigurations
        darwinPackages
        ;
    };

  inherit
    mkNixosConfiguration
    mkDarwinConfiguration
    ;
}
