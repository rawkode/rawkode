{ inputs, lib }:
let
  capabilityResolver = import ./capabilityResolver.nix { inherit inputs lib; };
  machineManifest = import ./machineManifest.nix { inherit lib; };

  # Library functions available to all modules via extraSpecialArgs
  rawkOSLib = {
    fileAsSeparatedString = path: builtins.readFile path;
  };

  preferencesFor =
    machine: username: preferences:
    let
      editor = inputs.self.machineManifests.${machine}.users.${username}.editor or null;
    in
    preferences // lib.optionalAttrs (editor != null) { inherit editor; };

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
      stylixHomeFor,
    }:
    let
      manifests = machineManifest.machinesForUser {
        manifests = inputs.self.machineManifests;
        inherit username;
      };
      machines = builtins.attrNames manifests;
    in
    builtins.listToAttrs (
      map (
        machine:
        let
          system = manifests.${machine}.system;

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
                rawkOSLib
                machine
                ;
              isDarwin = lib.strings.hasSuffix "darwin" system;
              osClass = "standalone";
              preferences = preferencesFor machine username preferences;
              stylixHome = stylixHomeFor machine;
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
      preferences ? {
        editor = "zed --wait";
      },
    }:
    let
      stylixHomeFor =
        machine:
        builtins.elem "theming" (
          capabilityResolver.resolveUserCapabilityNames {
            inherit
              machine
              username
              defaultCapabilities
              disabledCapabilities
              ;
          }
        );

      identity = {
        inherit username;
        name = if name != null then name else username;
        email = if email != null then email else throw "mkUser '${username}' requires an email";
        inherit signingKey;
      };

      homeModule =
        {
          lib,
          isDarwin,
          machine ? null,
          ...
        }:
        let
          hostPreferences = preferencesFor machine username preferences;
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
        in
        {
          home = {
            inherit username;
            homeDirectory = if isDarwin then homeDirectory.darwin else homeDirectory.linux;
            inherit stateVersion;

            sessionVariables = {
              EDITOR = hostPreferences.editor;
              SUDO_EDITOR = hostPreferences.editor;
              SYSTEMD_EDITOR = hostPreferences.editor;
              VISUAL = hostPreferences.editor;
            };
          };

          programs.home-manager.enable = true;

          nixpkgs.config.allowUnfree = true;

          manual.manpages.enable = false;

          targets.darwin = lib.mkIf isDarwin {
            copyApps.enable = false;
            linkApps.enable = true;
          };

          # homeExtraConfig is a regular home-manager module (attrset or function);
          # importing it lets the module system merge it instead of clobbering.
          imports =
            capabilityHomeImports
            ++ extraImports
            ++ platformExtraImports
            ++ (inputs.self.machineManifests.${machine}.users.${username}.modules or [ ])
            ++ lib.optional (homeExtraConfig != null) homeExtraConfig;
        };

      nixosHomeModule =
        {
          config,
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
              rawkOSLib
              machine
              ;
            inherit (pkgs.stdenv.hostPlatform) system;
            inherit (pkgs.stdenv.hostPlatform) isDarwin;
            preferences = preferencesFor machine username preferences;
            osClass = "nixos";
            # Stylix only auto-imports its HM options when system theming is enabled.
            stylixHome =
              (config.stylix.enable or false) && (config.stylix.homeManagerIntegration.autoImport or false);
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
              rawkOSLib
              machine
              ;
            system = darwinSystem;
            isDarwin = true;
            osClass = "darwin";
            preferences = preferencesFor machine username preferences;
            stylixHome = stylixHomeFor machine;
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
        if enableHomeConfigurations then
          mkHomeConfigurations {
            inherit
              username
              identity
              preferences
              homeModule
              stylixHomeFor
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
          ];
        };

      flake.darwinModules."users-${username}" =
        { ... }:
        {
          imports = [
            darwinHomeModule
            darwinUserModule
          ];
        };

      flake.homeConfigurations = homeConfigurations;
    };
in
mkUser
