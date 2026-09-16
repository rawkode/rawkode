{
  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.home-manager.flakeModules.home-manager
        inputs.treefmt-nix.flakeModule
        (inputs.import-tree ./modules)
      ];
    };

  inputs = {
    # Primary channel for the whole system.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Older channels kept only so individual packages can be pinned off
    # unstable: nixpkgs-25-05 -> modules/development/direnv, nixpkgs-stable
    # (25.11) -> modules/apps/bat and modules/shells/nushell. Drop a pin once
    # the package works on unstable again.
    nixpkgs-25-05.url = "github:NixOS/nixpkgs/nixos-25.05";
    nixpkgs-stable.url = "github:NixOS/nixpkgs/nixos-25.11";

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

    comma.url = "github:nix-community/comma";
    coreweave = {
      url = "github:coreweave/coreweave.nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.home-manager.follows = "home-manager";
      inputs.nix-darwin.follows = "nix-darwin";
      inputs.treefmt-nix.follows = "treefmt-nix";
    };
    cuenv.url = "github:cuenv/cuenv";
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    datumctl = {
      url = "github:datum-cloud/datumctl/v0.18.2";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    kree = {
      url = "path:../apps/kree";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    multipass = {
      url = "path:../apps/multipass";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-hardware = {
      url = "github:NixOS/nixos-hardware/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    niri = {
      url = "github:sodiboo/niri-flake";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-ai-tools.url = "github:numtide/llm-agents.nix";
    nur = {
      url = "github:nix-community/NUR";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    systems = {
      url = "github:nix-systems/default";
    };
    firefox-nightly.url = "github:nix-community/flake-firefox-nightly";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Pinned to the last vicinae revision compatible with our Stylix font
    # setup. Newer revisions type `programs.vicinae.settings.font.normal` as a
    # JSON value, which conflicts with the `{ family; size; }` attrset our
    # config supplies. Unpin once the upstream typing or our config is reconciled.
    vicinae.url = "github:vicinaehq/vicinae/db4c91c6638d191609e9e7e92d4ecddc8d54b1bb";
  };
}
