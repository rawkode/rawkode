{ inputs, ... }:
let
  machines = builtins.attrNames (builtins.readDir ../../machines);
  homeModule =
    {
      lib,
      system ? if builtins.hasAttr "currentSystem" builtins then builtins.currentSystem else "unknown",
      ...
    }:
    let
      isDarwin = lib.hasSuffix "darwin" system;
      homeDirectory = if isDarwin then "/Users/rawkode" else "/home/rawkode";

      linuxImports = with inputs; [
        nix-index-database.homeModules.nix-index
        nur.modules.homeManager.default
        flatpaks.homeManagerModules.nix-flatpak
        ironbar.homeManagerModules.default
        niri.homeModules.niri
        vicinae.homeManagerModules.default

        self.homeModules.ai
        self.homeModules.command-line
        self.homeModules.desktop
        self.homeModules.development
        self.homeModules.fish
        self.homeModules.flatpak
        self.homeModules.gnome
        self.homeModules.ironbar
        self.homeModules.nix-home
        self.homeModules.portals
        self.homeModules.stylix
        self.homeModules.vicinae
      ];

      darwinImports = with inputs; [
        # NOTE: fish, starship, atuin, carapace, comma, and zoxide are
        # already imported via command-line module - don't duplicate them!

        # Editor and CLI toolkit
        self.homeModules.command-line

        # Nix CLI config for HM (required by modules that set nix.settings)
        self.homeModules.nix-home

        # Developer tooling (Docker client, Podman, language toolchains, etc.)
        self.homeModules.development

        # Apps and theming
        self.homeModules.ghostty
        self.homeModules.git
        self.homeModules.stylix
      ];
    in
    {
      home = {
        username = "rawkode";
        inherit homeDirectory;
        stateVersion = "25.11";
      };

      programs.home-manager.enable = true;

      nixpkgs.config.allowUnfree = true;

      imports = if isDarwin then darwinImports else linuxImports;
    }
    // lib.optionalAttrs (!isDarwin) {
      rawkOS.desktop.darkman.enable = false;
    };

  flake.homeModules.users-rawkode = homeModule;

  flake.homeConfigurations = builtins.listToAttrs (
    map (
      machine:
      let
        # Look up the machine's system from the existing flake configuration so we
        # build the matching home-manager packages instead of defaulting to Linux.
        configForMachine =
          if
            inputs.self ? darwinConfigurations && builtins.hasAttr machine inputs.self.darwinConfigurations
          then
            inputs.self.darwinConfigurations.${machine}
          else if
            inputs.self ? nixosConfigurations && builtins.hasAttr machine inputs.self.nixosConfigurations
          then
            inputs.self.nixosConfigurations.${machine}
          else
            throw "No darwin or nixos configuration found for ${machine}";

        system =
          if
            configForMachine ? pkgs && configForMachine.pkgs ? stdenv && configForMachine.pkgs.stdenv ? system
          then
            configForMachine.pkgs.stdenv.system
          else if
            configForMachine ? config
            && configForMachine.config ? nixpkgs
            && configForMachine.config.nixpkgs ? hostPlatform
            && configForMachine.config.nixpkgs.hostPlatform ? system
          then
            configForMachine.config.nixpkgs.hostPlatform.system
          else
            throw "Unable to detect system for ${machine}";

        pkgs = inputs.nixpkgs.legacyPackages.${system};
      in
      {
        name = "rawkode@${machine}";
        value = inputs.home-manager.lib.homeManagerConfiguration {
          inherit pkgs;
          modules = [ homeModule ];
          extraSpecialArgs = {
            inherit inputs system;
          };
        };
      }
    ) machines
  );

  flake.nixosModules.users-rawkode.imports = [
    home
    linux
    user
  ];

  flake.darwinModules.users-rawkode =
    { pkgs, ... }:
    {
      home-manager.backupFileExtension = "hm-backup";
      home-manager.overwriteBackup = true;
      home-manager.useUserPackages = true;
      home-manager.extraSpecialArgs = {
        inherit inputs;
        system = "aarch64-darwin";
      };
      home-manager.users.rawkode = homeModule;
    };

  home.home-manager.users.rawkode.imports = [
    homeModule
  ];

  linux = {
    users.users.rawkode = {
      isNormalUser = true;
      extraGroups = [
        "audio"
        "docker"
        "input"
        "libvirtd"
        "video"
        "wheel"
      ];
    };
  };

  user =
    { pkgs, ... }:
    {
      home-manager.backupFileExtension = "backup";

      users.users.rawkode = {
        description = "David Flanagan";
        shell = pkgs.fish;
      };
    };
in
{
  inherit flake;
}
