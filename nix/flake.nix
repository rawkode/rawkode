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
    # unstable: nixpkgs-stable (25.11) -> Darwin bat-extras/FZF/Nushell and
    # CoreWeave's teleport_17 client; nixpkgs-teleport -> modules/apps/teleport
    # (unstable's teleport_18 fails to link its RDP client). Drop a pin once the
    # package works on unstable again.
    nixpkgs-stable.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixpkgs-teleport.url = "github:NixOS/nixpkgs/e39ece893d8549175630848b279b29c9d75947aa";

    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
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
    eloquawk.url = "github:korora-tech/eloquawk";
    flipper.url = "github:korora-tech/flipper";
    rockhopper.url = "github:korora-tech/rockhopper";
    coreweave = {
      url = "github:coreweave/coreweave.nix";
      inputs.nixpkgs.follows = "nixpkgs-stable";
      inputs.home-manager.follows = "home-manager";
      inputs.nix-darwin.follows = "nix-darwin";
      inputs.treefmt-nix.follows = "treefmt-nix";
    };
    cuenv.url = "github:cuenv/cuenv";
    dagger.url = "github:dagger/nix";
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
    # The cachix branches track the newest commit with prebuilt binaries. These
    # inputs keep their own nixpkgs so store paths match the upstream caches.
    luciole.url = "github:noctalia-dev/luciole/cachix";
    noctalia.url = "github:noctalia-dev/noctalia/cachix";
    noctalia-greeter.url = "github:noctalia-dev/noctalia-greeter";
    umbriel.url = "github:noctalia-dev/umbriel/cachix";
    llm-agents.url = "github:numtide/llm-agents.nix";
    nur = {
      url = "github:nix-community/NUR";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-parts.follows = "flake-parts";
    };
    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-parts.follows = "flake-parts";
      inputs.nur.follows = "nur";
      inputs.systems.follows = "systems";
    };
    # Keep Sonora's nixpkgs pin so builds match sonora.cachix.org.
    sonora.url = "github:sonorahq/sonora";
    systems = {
      url = "github:nix-systems/default";
    };
    firefox-nightly.url = "github:nix-community/flake-firefox-nightly";
    browser-previews = {
      url = "github:nix-community/browser-previews";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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
