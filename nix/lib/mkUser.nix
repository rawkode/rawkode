{ inputs, lib }:
let
  capabilityResolver = import ./capabilityResolver.nix { inherit inputs lib; };

  # Library functions available to all modules via extraSpecialArgs
  rawkOSLib = {
    fileAsSeparatedString = path: builtins.readFile path;
  };

  resolveConfig =
    config: args:
    if config == null then
      { }
    else if lib.isFunction config then
      config args
    else
      config;

  resolveCapabilityImports =
    {
      kind,
      machine,
      username,
      defaultCapabilities,
      disabledCapabilities,
    }:
    capabilityResolver.resolveUserCapabilityImports {
      inherit
        kind
        machine
        username
        defaultCapabilities
        disabledCapabilities
        ;
    };

  mkHomeConfigurations =
    {
      username,
      identity,
      preferences,
      homeModule,
      machinesDir,
      machineSystems,
    }:
    let
      machines = builtins.attrNames (
        lib.filterAttrs (_name: type: type == "directory") (builtins.readDir machinesDir)
      );
    in
    builtins.listToAttrs (
      map (
        machine:
        let
          system =
            if machineSystems != null && builtins.hasAttr machine machineSystems then
              machineSystems.${machine}
            else
              throw "No system mapping found for ${machine} in machineSystems";

          pkgs = inputs.nixpkgs.legacyPackages.${system};
        in
        {
          name = "${username}@${machine}";
          value = inputs.home-manager.lib.homeManagerConfiguration {
            inherit pkgs;
            modules = [ homeModule ];
            extraSpecialArgs = {
              inherit
                inputs
                system
                identity
                preferences
                rawkOSLib
                machine
                ;
              isDarwin = lib.strings.hasSuffix "darwin" system;
              osClass = "standalone";
            };
          };
        }
      ) machines
    );

  mkUser =
    {
      username,
      name ? null,
      email ? null,
      signingKey ? null,
      stateVersion ? "25.11",
      homeDirectory ? {
        darwin = "/Users/${username}";
        linux = "/home/${username}";
      },
      apps ? [ ],
      defaultCapabilities ? [ ],
      disabledCapabilities ? [ ],
      extraImports ? [ ],
      linuxExtraImports ? [ ],
      darwinExtraImports ? [ ],
      homeExtraConfig ? null,
      nixosUserConfig ? null,
      nixosBackupExtension ? "backup",
      darwinBackupExtension ? "hm-backup",
      darwinSystem ? "aarch64-darwin",
      enableHomeConfigurations ? false,
      machinesDir ? null,
      machineSystems ? null,
      preferences ? {
        editor = "hx";
      },
    }:
    let
      identity = {
        inherit username;
        name = if name != null then name else username;
        email = if email != null then email else "${username}@localhost";
        inherit signingKey;
      };

      legacyAppHomeImports = map (app: app.home) apps;
      legacyAppDarwinImports = map (app: app.darwin) apps;
      legacyAppNixosImports = map (app: app.nixos) apps;

      homeModule =
        {
          lib,
          pkgs,
          system,
          isDarwin,
          machine ? null,
          ...
        }:
        let
          capabilityHomeImports = resolveCapabilityImports {
            kind = "home";
            inherit
              machine
              username
              defaultCapabilities
              disabledCapabilities
              ;
          };

          platformExtraImports = if isDarwin then darwinExtraImports else linuxExtraImports;

          baseConfig = {
            home = {
              inherit username;
              homeDirectory = if isDarwin then homeDirectory.darwin else homeDirectory.linux;
              inherit stateVersion;
            };

            programs.home-manager.enable = true;

            nixpkgs.config.allowUnfree = true;

            targets.darwin = lib.mkIf isDarwin {
              copyApps.enable = false;
              linkApps.enable = true;
            };

            imports = legacyAppHomeImports ++ capabilityHomeImports ++ extraImports ++ platformExtraImports;
          };

          extraConfig = resolveConfig homeExtraConfig {
            inherit
              lib
              system
              isDarwin
              pkgs
              machine
              ;
          };
        in
        baseConfig // extraConfig;

      nixosHomeModule =
        {
          pkgs,
          machine ? null,
          ...
        }:
        {
          home-manager.backupFileExtension = nixosBackupExtension;
          home-manager.extraSpecialArgs = {
            inherit
              inputs
              identity
              preferences
              rawkOSLib
              machine
              ;
            inherit (pkgs.stdenv.hostPlatform) system;
            inherit (pkgs.stdenv) isDarwin;
            osClass = "nixos";
          };
          home-manager.users.${username}.imports = [ homeModule ];
        };

      nixosUserModule =
        { pkgs, ... }:
        let
          userConfig = resolveConfig nixosUserConfig { inherit pkgs; };
        in
        {
          rawkOS.user = {
            inherit username;
            inherit (identity) name;
          };

          users.users.${username} = {
            isNormalUser = true;
          }
          // lib.optionalAttrs (name != null) { description = name; }
          // userConfig;
        };

      darwinHomeModule =
        {
          machine ? null,
          ...
        }:
        {
          home-manager.backupFileExtension = darwinBackupExtension;
          home-manager.overwriteBackup = true;
          home-manager.useUserPackages = true;
          home-manager.extraSpecialArgs = {
            inherit
              inputs
              identity
              preferences
              rawkOSLib
              machine
              ;
            system = darwinSystem;
            isDarwin = true;
            osClass = "darwin";
          };
          home-manager.users.${username} = homeModule;
        };

      darwinUserModule = {
        rawkOS.user = {
          inherit username;
          inherit (identity) name;
        };

        users.users.${username} = {
          name = username;
          home = homeDirectory.darwin;
        };
        system.primaryUser = username;
      };

      homeConfigurations =
        if enableHomeConfigurations && machinesDir != null then
          mkHomeConfigurations {
            inherit
              username
              identity
              preferences
              homeModule
              machinesDir
              machineSystems
              ;
          }
        else
          { };
    in
    {
      flake.homeModules."users-${username}" = homeModule;

      flake.nixosModules."users-${username}" =
        {
          machine ? null,
          ...
        }:
        {
          imports = [
            nixosHomeModule
            nixosUserModule
          ]
          ++ legacyAppNixosImports
          ++ resolveCapabilityImports {
              kind = "nixos";
              inherit
                machine
                username
                defaultCapabilities
                disabledCapabilities
                ;
          };
        };

      flake.darwinModules."users-${username}" =
        {
          machine ? null,
          ...
        }:
        {
          imports = [
            darwinHomeModule
            darwinUserModule
          ]
          ++ legacyAppDarwinImports
          ++ resolveCapabilityImports {
              kind = "darwin";
              inherit
                machine
                username
                defaultCapabilities
                disabledCapabilities
                ;
            };
        };

      flake.homeConfigurations = homeConfigurations;
    };
in
mkUser
