{
  flake.nixosModules.profiles-base =
    {
      inputs,
      lib,
      pkgs,
      ...
    }:
    {
      imports = with inputs; [
        disko.nixosModules.disko
        flatpaks.nixosModules.nix-flatpak
        niri.nixosModules.niri
        nix-index-database.nixosModules.nix-index
        nur.modules.nixos.default

        self.nixosModules.below
        self.nixosModules.common
        self.nixosModules.containers
        self.nixosModules.fish
        self.nixosModules.greetd
        self.nixosModules.lanzaboote
        self.nixosModules.networking
        self.nixosModules.nix
        self.nixosModules.stylix
        self.nixosModules.sudo
        self.nixosModules.systemd
        self.nixosModules.tailscale
        self.nixosModules.tpm2
        self.nixosModules.user
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
}
