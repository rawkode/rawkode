{ inputs, lib }:
let
  capabilityResolver = import ./capabilityResolver.nix { inherit inputs lib; };
  machineManifest = import ./machineManifest.nix { inherit lib; };

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
      { config, lib, ... }:
      {
        networking.hostName = machine;
        # The primary user's Home Manager preferences own the editor. A host
        # override therefore applies to both system and user environments.
        environment.variables = lib.genAttrs [ "EDITOR" "SUDO_EDITOR" "SYSTEMD_EDITOR" "VISUAL" ] (
          name:
          config.home-manager.users.${
            inputs.self.machineManifests.${machine}.primaryUser
          }.home.sessionVariables.${name}
        );
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

  modulesForMachine =
    {
      machine,
      manifest,
      traits,
      kind,
    }:
    traitImportsFor {
      inherit kind traits;
      selected = manifest.traits or [ ];
    }
    ++ capabilityResolver.resolveMachineCapabilityImports {
      inherit kind machine;
    }
    ++ userImportsFor {
      inherit kind;
      users = usersFor manifest;
    }
    ++ [
      (mkNetworkingModule {
        inherit (manifest) platform;
        inherit machine;
      })
    ]
    ++ localModulesFor manifest;

  wrapModuleWithSpecialArgs =
    {
      machine,
      module,
    }:
    let
      specialArgs = commonSpecialArgs { inherit machine; } // {
        inherit (inputs) self;
      };

      wrap =
        file: value:
        if lib.isFunction value then
          lib.setFunctionArgs (
            args:
            let
              result = value (args // specialArgs);
            in
            if lib.isAttrs result then wrap file result else result
          ) (lib.functionArgs value)
        else if builtins.isPath value || builtins.isString value then
          wrap (toString value) (import value)
        else if lib.isAttrs value then
          value
          // (lib.optionalAttrs (value ? imports) {
            imports = map (wrap null) value.imports;
          })
          // (lib.optionalAttrs (file != null && !(value ? _file)) {
            _file = file;
          })
        else
          value;
    in
    wrap null module;

  platformImpl = {
    nixos = {
      kind = "nixos";
      mkSystem = args: inputs.nixpkgs.lib.nixosSystem args;
    };
    darwin = {
      kind = "darwin";
      mkSystem = args: inputs.nix-darwin.lib.darwinSystem args;
    };
  };

  mkConfiguration =
    {
      machine,
      manifest,
      traits,
    }:
    let
      impl =
        platformImpl.${manifest.platform} or (throw "Unknown machine platform '${manifest.platform}'");
    in
    impl.mkSystem {
      inherit (manifest) system;
      modules = modulesForMachine {
        inherit machine manifest traits;
        inherit (impl) kind;
      };
      specialArgs = commonSpecialArgs { inherit machine; };
    };

  devenvMachineFor =
    {
      machine,
      manifest,
      traits,
    }:
    let
      impl =
        platformImpl.${manifest.platform} or (throw "Unknown machine platform '${manifest.platform}'");
      role = if manifest.platform == "nixos" then "nixos" else "nix-darwin";
      roleModule = wrapModuleWithSpecialArgs {
        inherit machine;
        module = {
          imports = modulesForMachine {
            inherit machine manifest traits;
            inherit (impl) kind;
          };
        };
      };
    in
    {
      inherit (manifest) system;
    }
    // builtins.listToAttrs [
      {
        name = role;
        value = roleModule;
      }
    ];

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
      validatedManifests = lib.mapAttrs (
        machine: manifest:
        machineManifest.validate {
          capabilityBundles = inputs.self.capabilityBundles;
          inherit machine manifest traits;
        }
      ) manifests;
      nixosConfigurations = configsForPlatform {
        platform = "nixos";
        manifests = validatedManifests;
        inherit traits;
      };
      darwinConfigurations = configsForPlatform {
        platform = "darwin";
        manifests = validatedManifests;
        inherit traits;
      };
      darwinPackages = darwinPackageAliases {
        inherit darwinConfigurations;
        manifests = validatedManifests;
      };
      devenvMachines = lib.mapAttrs (
        machine: manifest:
        devenvMachineFor {
          inherit machine manifest traits;
        }
      ) validatedManifests;
    in
    {
      inherit
        nixosConfigurations
        darwinConfigurations
        darwinPackages
        devenvMachines
        ;
    };
}
