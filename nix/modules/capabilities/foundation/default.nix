{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "foundation";

  nixos =
    {
      inputs,
      lib,
      pkgs,
      ...
    }:
    {
      imports = [
        inputs.disko.nixosModules.disko
        inputs.flatpaks.nixosModules.nix-flatpak
        inputs.home-manager.nixosModules.home-manager
        inputs.lanzaboote.nixosModules.lanzaboote
        inputs.niri.nixosModules.niri
        inputs.nix-index-database.nixosModules.nix-index
        inputs.nur.modules.nixos.default

        inputs.self.nixosModules.below
        inputs.self.nixosModules.common
        inputs.self.nixosModules.containers
        inputs.self.nixosModules.fish
        inputs.self.nixosModules.greetd
        inputs.self.nixosModules.networking
        inputs.self.nixosModules.nix
        inputs.self.nixosModules.stylix
        inputs.self.nixosModules.sudo
        inputs.self.nixosModules.systemd
        inputs.self.nixosModules.tpm2
        inputs.self.nixosModules.user
      ];

      environment.systemPackages = with pkgs; [
        curl
        git
        htop
        nodejs
        vim
        wget
      ];

      boot.loader.efi = {
        canTouchEfiVariables = lib.mkDefault true;
        efiSysMountPoint = lib.mkDefault "/boot";
      };

      nixpkgs.config = {
        allowUnfree = true;
        joypixels.acceptLicense = true;
      };

      nix = {
        settings = {
          experimental-features = [
            "nix-command"
            "flakes"
          ];
          auto-optimise-store = true;
        };
        gc = {
          automatic = lib.mkDefault true;
          dates = "weekly";
          options = "--delete-older-than 30d";
        };
        registry = {
          nixpkgs.flake = inputs.nixpkgs;
          rawkode.flake = inputs.self;
          templates.flake = inputs.self;
        };
      };

      system.stateVersion = "25.11";
    };

  darwin = [
    inputs.home-manager.darwinModules.home-manager
    inputs.self.darwinModules.nix
    inputs.self.darwinModules.profiles-base
    inputs.self.darwinModules.fish
    inputs.self.darwinModules.user
  ];

  home = {
    imports = with inputs.self; [
      homeModules.profiles-users-common
      homeModules.stylix

      appBundles.atuin.home
      appBundles.bat.home
      appBundles.btop.home
      appBundles.carapace.home
      appBundles.eza.home
      appBundles.fish.home
      appBundles.git.home
      appBundles.github.home
      appBundles.htop.home
      appBundles.jj.home
      appBundles.jq.home
      appBundles.misc.home
      appBundles.nushell.home
      appBundles.ouch.home
      appBundles.ripgrep.home
      appBundles.starship.home
      appBundles.zoxide.home
    ];
  };
}
