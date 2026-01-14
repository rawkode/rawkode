{ inputs }:
let
  inherit (inputs.nixpkgs) lib;

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
              inherit inputs system;
              isDarwin = lib.strings.hasSuffix "darwin" system;
            };
          };
        }
      ) machines
    );

  mkUser =
    {
      username,
      name ? null,
      stateVersion ? "25.11",
      homeDirectory ? {
        darwin = "/Users/${username}";
        linux = "/home/${username}";
      },
      homeImports ? {
        linux = [ ];
        darwin = [ ];
      },
      homeExtraConfig ? null,
      nixosUserConfig ? null,
      nixosExtraImports ? [ ],
      darwinExtraImports ? [ ],
      nixosBackupExtension ? "backup",
      darwinBackupExtension ? "hm-backup",
      darwinSystem ? "aarch64-darwin",
      enableHomeConfigurations ? false,
      machinesDir ? null,
      machineSystems ? null,
    }:
    let
      homeModule =
        {
          lib,
          pkgs,
          system,
          isDarwin,
          ...
        }:
        let
          baseConfig = {
            home = {
              inherit username;
              homeDirectory = if isDarwin then homeDirectory.darwin else homeDirectory.linux;
              inherit stateVersion;
            };

            programs.home-manager.enable = true;

            nixpkgs.config.allowUnfree = true;

            imports = if isDarwin then homeImports.darwin else homeImports.linux;
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
            inherit inputs;
            inherit (pkgs.stdenv.hostPlatform) system;
            inherit (pkgs.stdenv) isDarwin;
          };
          home-manager.users.${username}.imports = [ homeModule ];
        };

      nixosUserModule =
        { pkgs, ... }:
        let
          userConfig = resolveConfig nixosUserConfig { inherit pkgs; };
        in
        {
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
          inherit inputs;
          system = darwinSystem;
          isDarwin = true;
        };
        home-manager.users.${username} = homeModule;
      };

      homeConfigurations =
        if enableHomeConfigurations && machinesDir != null then
          mkHomeConfigurations {
            inherit
              username
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
          ++ nixosExtraImports;
        };

      flake.darwinModules."users-${username}" =
        { ... }:
        {
          imports = [ darwinHomeModule ] ++ darwinExtraImports;
        };

      flake.homeConfigurations = homeConfigurations;
    };
in
mkUser
