{ inputs, lib }:
let

  # Library functions available to all modules via extraSpecialArgs
  rawkOSLib = {
    fileAsSeparatedString =
      path: lib.strings.concatStringsSep "\n" (lib.strings.splitString "\n" (builtins.readFile path));
  };

  resolveConfig =
    config: args:
    if config == null then
      { }
    else if lib.isFunction config then
      config args
    else
      config;

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
      machines = builtins.attrNames (builtins.readDir machinesDir);
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
      # NEW: list of app bundles from inputs.self.appBundles.*
      # Each app is { home = module; darwin = module; nixos = module; }
      apps ? [ ],
      # Additional imports for home-manager (e.g., profile modules)
      # These are included on all platforms
      extraImports ? [ ],
      # Platform-specific imports (e.g., nix-flatpak on Linux)
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
      # Identity object passed to all modules via extraSpecialArgs
      identity = {
        inherit username;
        name = if name != null then name else username;
        email = if email != null then email else "${username}@localhost";
        inherit signingKey;
      };

      # Extract modules from app bundles
      appHomeImports = map (app: app.home) apps;
      appDarwinImports = map (app: app.darwin) apps;
      appNixosImports = map (app: app.nixos) apps;

      homeModule =
        {
          lib,
          pkgs,
          system,
          isDarwin,
          ...
        }:
        let
          # Platform-specific extra imports
          platformExtraImports = if isDarwin then darwinExtraImports else linuxExtraImports;

          baseConfig = {
            home = {
              inherit username;
              homeDirectory = if isDarwin then homeDirectory.darwin else homeDirectory.linux;
              inherit stateVersion;
            };

            programs.home-manager.enable = true;

            nixpkgs.config.allowUnfree = true;

            # Darwin-specific: use linkApps instead of copyApps to avoid App Management permission
            targets.darwin = lib.mkIf isDarwin {
              copyApps.enable = false;
              linkApps.enable = true;
            };

            # All app home modules (platform-aware) + extra imports + platform-specific imports
            imports = appHomeImports ++ extraImports ++ platformExtraImports;
          };

          extraConfig = resolveConfig homeExtraConfig {
            inherit
              lib
              system
              isDarwin
              pkgs
              ;
          };
        in
        baseConfig // extraConfig;

      nixosHomeModule =
        { pkgs, ... }:
        {
          home-manager.backupFileExtension = nixosBackupExtension;
          home-manager.extraSpecialArgs = {
            inherit
              inputs
              identity
              preferences
              rawkOSLib
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
          # Set rawkOS.user options from identity
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

      darwinHomeModule = {
        home-manager.backupFileExtension = darwinBackupExtension;
        home-manager.overwriteBackup = true;
        home-manager.useUserPackages = true;
        home-manager.extraSpecialArgs = {
          inherit
            inputs
            identity
            preferences
            rawkOSLib
            ;
          system = darwinSystem;
          isDarwin = true;
          osClass = "darwin";
        };
        home-manager.users.${username} = homeModule;
      };

      darwinUserModule = {
        # Set rawkOS.user options from identity (needed by other modules)
        rawkOS.user = {
          inherit username;
          inherit (identity) name;
        };

        # Set user for darwin
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
        { ... }:
        {
          imports = [
            nixosHomeModule
            nixosUserModule
          ]
          ++ appNixosImports;
        };

      flake.darwinModules."users-${username}" =
        { ... }:
        {
          imports = [
            darwinHomeModule
            darwinUserModule
          ]
          ++ appDarwinImports;
        };

      flake.homeConfigurations = homeConfigurations;
    };
in
mkUser
