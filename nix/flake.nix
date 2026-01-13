{
  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.home-manager.flakeModules.home-manager
        inputs.treefmt-nix.flakeModule
      ]
      ++ (inputs.import-tree ./modules).imports;
    };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";
    import-tree.url = "github:vic/import-tree";

    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    browser-previews.url = "github:nix-community/browser-previews";
    comma.url = "github:nix-community/comma";
    cuenv.url = "github:cuenv/cuenv";
    dagger.url = "github:dagger/nix";
    disko.url = "github:nix-community/disko";
    firefox.url = "github:nix-community/flake-firefox-nightly";
    flatpaks.url = "github:gmodena/nix-flatpak";

    # Follows unstable because of a mesa mismatch
    # Revert follows after 25.11
    ghostty = {
      url = "github:ghostty-org/ghostty/v1.2.0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    ironbar.url = "github:JakeStanger/ironbar";
    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-facter-modules.url = "github:numtide/nixos-facter-modules";
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    niri = {
      url = "github:sodiboo/niri-flake";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-ai-tools.url = "github:numtide/nix-ai-tools";
    nur.url = "github:nix-community/NUR";
    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.home-manager.follows = "home-manager";
    };
    systems = {
      url = "github:nix-systems/default";
    };
    treefmt-nix.url = "github:numtide/treefmt-nix";
    vicinae.url = "github:vicinaehq/vicinae/db4c91c6638d191609e9e7e92d4ecddc8d54b1bb";
  };
}
