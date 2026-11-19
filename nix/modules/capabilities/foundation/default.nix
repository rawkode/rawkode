{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
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
        inputs.home-manager.nixosModules.home-manager
        inputs.nix-index-database.nixosModules.nix-index
        inputs.nur.modules.nixos.default

        inputs.self.nixosModules.below
        inputs.self.nixosModules.common
        inputs.self.nixosModules.fish
        inputs.self.nixosModules.nushell
        inputs.self.nixosModules.networking
        inputs.self.nixosModules.nix
        inputs.self.nixosModules.sudo
        inputs.self.nixosModules.systemd
        inputs.self.nixosModules.user
      ];

      environment.systemPackages = with pkgs; [
        curl
        htop
        vim
        wget
      ];

      boot.kernelPackages = lib.mkDefault pkgs.linuxPackages_latest;

      nixpkgs.config = {
        allowUnfree = true;
        joypixels.acceptLicense = true;
      };

      nix.registry = {
        nixpkgs.flake = inputs.nixpkgs;
        rawkode.flake = inputs.self;
        templates.flake = inputs.self;
      };

      system.stateVersion = "25.11";
    };

  darwin = [
    inputs.home-manager.darwinModules.home-manager
    inputs.self.appBundles.github.darwin
    inputs.self.darwinModules.nix
    inputs.self.darwinModules.macos-base
    inputs.self.darwinModules.fish
    inputs.self.darwinModules.nushell
    inputs.self.darwinModules.user
    { nixpkgs.config.allowUnfree = true; }
  ];

  home =
    {
      lib,
      osClass ? "standalone",
      ...
    }:
    {
      imports = [
        inputs.nix-index-database.homeModules.nix-index
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
      ]
      ++ lib.optionals (osClass != "nixos") [
        inputs.nur.modules.homeManager.default
      ];
    };
}
