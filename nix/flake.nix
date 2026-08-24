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
    nixpkgs-25-05.url = "github:NixOS/nixpkgs/nixos-25.05";
    nixpkgs-stable.url = "github:NixOS/nixpkgs/nixos-25.11";

    flake-parts.url = "github:hercules-ci/flake-parts";
    import-tree.url = "github:vic/import-tree";
    impeccable = {
      url = "github:pbakaus/impeccable";
      flake = false;
    };

    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    comma.url = "github:nix-community/comma";
    coreweave.url = "github:coreweave/coreweave.nix";
    cuenv.url = "github:cuenv/cuenv";
    # Cuetty is currently published from the app flake in the open Cuenv PR.
    # Keep the exact reviewed revision in the lock file until the package is
    # exported from Cuenv's root flake.
    cuetty = {
      url = "github:cuenv/cuenv/7afacce08b64dc7ca4cf2b5cf5c968fb51a9a127?dir=apps/cuetty";
      inputs.nixpkgs.follows = "nixpkgs-stable";
    };
    disko.url = "github:nix-community/disko";
    kree.url = "path:../apps/kree";
    flatpaks.url = "github:gmodena/nix-flatpak";

    ghostty = {
      url = "github:ghostty-org/ghostty";
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
    nix-ai-tools.url = "github:numtide/llm-agents.nix";
    nur.url = "github:nix-community/NUR";
    orca = {
      url = "github:stablyai/orca";
      flake = false;
    };
    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    systems = {
      url = "github:nix-systems/default";
    };
    browser-previews.url = "github:nix-community/browser-previews";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    vicinae.url = "github:vicinaehq/vicinae/db4c91c6638d191609e9e7e92d4ecddc8d54b1bb";
  };
}
