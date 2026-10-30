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
    # unstable: nixpkgs-25-05 -> modules/development/direnv; nixpkgs-stable
    # (25.11) -> modules/apps/bat, Darwin FZF/Nushell, and CoreWeave's Go 1.25
    # package. Drop a pin once the package works on unstable again.
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

    # Keep the Korora Tech package pins so their matching builds can come from its cache.
    antarctical.url = "github:korora-tech/antarctical";
    chinstrap.url = "github:korora-tech/chinstrap";
    eloquawk = {
      url = "github:korora-tech/eloquawk";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flipper.url = "github:korora-tech/flipper";
    rockhopper.url = "github:korora-tech/rockhopper";
    comma.url = "github:nix-community/comma";
    coreweave = {
      url = "github:coreweave/coreweave.nix";
      inputs.nixpkgs.follows = "nixpkgs-stable";
      inputs.home-manager.follows = "home-manager";
      inputs.nix-darwin.follows = "nix-darwin";
      inputs.treefmt-nix.follows = "treefmt-nix";
    };
    cuenv.url = "github:cuenv/cuenv";
    cuetty = {
      url = "github:cuenv/cuenv?dir=apps/cuetty";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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
    dux = {
      url = "github:duxlabs-dev/dux-shell/stable";
      inputs.nixpkgs.follows = "nixpkgs";
    };

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
    llm-agents.url = "github:numtide/llm-agents.nix";
    nur = {
      url = "github:nix-community/NUR";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sonora = {
      url = "github:sonorahq/sonora";
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
    waddle = {
      url = "github:waddle-social/waddle";
      flake = false;
    };
  };
}
