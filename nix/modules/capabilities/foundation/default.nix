{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "foundation";

  nixos =
    {
      inputs,
      pkgs,
      ...
    }:
    {
      imports = [
        inputs.home-manager.nixosModules.home-manager
        inputs.nix-index-database.nixosModules.nix-index
        inputs.nur.modules.nixos.default

        inputs.self.nixosModules.below
        inputs.self.nixosModules.common
        inputs.self.nixosModules.fish
        inputs.self.nixosModules.networking
        inputs.self.nixosModules.nix
        inputs.self.nixosModules.sudo
        inputs.self.nixosModules.systemd
        inputs.self.nixosModules.user
      ];

      environment.systemPackages = with pkgs; [
        curl
        git
        htop
        vim
        wget
      ];

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
    inputs.self.darwinModules.macos-base
    inputs.self.darwinModules.fish
    inputs.self.darwinModules.user
  ];

  home = {
    imports = [
      inputs.nix-index-database.homeModules.nix-index
      inputs.nur.modules.homeManager.default
      inputs.self.homeModules.nix-home

      inputs.self.appBundles.atuin.home
      inputs.self.appBundles.bat.home
      inputs.self.appBundles.btop.home
      inputs.self.appBundles.carapace.home
      inputs.self.appBundles.eza.home
      inputs.self.appBundles.fish.home
      inputs.self.appBundles.git.home
      inputs.self.appBundles.github.home
      inputs.self.appBundles.helix.home
      inputs.self.appBundles.htop.home
      inputs.self.appBundles.jj.home
      inputs.self.appBundles.jq.home
      inputs.self.appBundles.misc.home
      inputs.self.appBundles.nushell.home
      inputs.self.appBundles.ouch.home
      inputs.self.appBundles.ripgrep.home
      inputs.self.appBundles.starship.home
      inputs.self.appBundles.zoxide.home
    ];
  };
}
