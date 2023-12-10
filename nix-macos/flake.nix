{
  description = "Rawkode's macOS Configuration, powered by nix";

  inputs = {
    fenix = { url = "https://flakehub.com/f/nix-community/fenix/0.1.*.tar.gz"; inputs.nixpkgs.follows = "nixpkgs"; };
    fh = { url = "https://flakehub.com/f/DeterminateSystems/fh/0.1.*.tar.gz"; inputs.nixpkgs.follows = "nixpkgs"; };
    flake-checker = { url = "https://flakehub.com/f/DeterminateSystems/flake-checker/0.1.*.tar.gz"; inputs.nixpkgs.follows = "nixpkgs"; };
    flake-schemas.url = "https://flakehub.com/f/DeterminateSystems/flake-schemas/0.1.*.tar.gz";
    home-manager = { url = "https://flakehub.com/f/nix-community/home-manager/0.2311.*.tar.gz"; inputs.nixpkgs.follows = "nixpkgs"; };
    nix-darwin = { url = "github:LnL7/nix-darwin"; inputs.nixpkgs.follows = "nixpkgs"; };
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.2311.*.tar.gz";
    # nuenv = { url = "https://flakehub.com/f/DeterminateSystems/nuenv/0.1.*.tar.gz"; inputs.nixpkgs.follows = "nixpkgs"; };
    # uuidv7 = { url = "git+ssh://git@github.com/DeterminateSystems/uuidv7.git"; inputs.nixpkgs.follows = "nixpkgs"; };
  };

  outputs = inputs:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-darwin" "aarch64-linux" ];
      forEachSupportedSystem = f: inputs.nixpkgs.lib.genAttrs supportedSystems (system: f {
        pkgs = import inputs.nixpkgs {
          inherit system;
          overlays = [ inputs.self.overlays.default ];
        };
      });

      stateVersion = "23.11";
      system = "aarch64-darwin";
      username = "rawkode";
      caches = {
        nixos-org = {
          cache = "https://cache.nixos.org";
          publicKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
        };
        nix-community = {
          cache = "https://nix-community.cachix.org";
          publicKey = "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=";
        };
      };
    in
    {
      schemas = inputs.flake-schemas.schemas;

      devShells = forEachSupportedSystem ({ pkgs }: {
        default =
          let
            reload = pkgs.writeScriptBin "reload" ''
              CONFIG_NAME="''${USER}-$(nix eval --impure --raw --expr 'builtins.currentSystem')"
              ${pkgs.nixFlakes}/bin/nix build .#darwinConfigurations."''${CONFIG_NAME}".system \
                --option sandbox false
              ./result/sw/bin/darwin-rebuild switch --flake .
            '';
          in
          pkgs.mkShell {
            name = "nome";
            packages = with pkgs; [
              nixpkgs-fmt
              reload
              rnix-lsp
            ];
          };
      });

      overlays.default = final: prev: {
        inherit username system;
        homeDirectory =
          if (prev.stdenv.isDarwin)
          then "/Users/${username}"
          else "/home/${username}";
        rev = inputs.self.rev or inputs.self.dirtyRev or null;
        flake-checker = inputs.flake-checker.packages.${system}.default;
        fh = inputs.fh.packages.${system}.default;
        uuidv7 = inputs.uuidv7.packages.${system}.default;
        rustToolchain = with inputs.fenix.packages.${system};
          combine (with stable; [
            cargo
            clippy
            rustc
            rustfmt
            rust-src
          ]);
      };

      darwinConfigurations."${username}-${system}" = inputs.nix-darwin.lib.darwinSystem {
        inherit system;
        modules = [
          inputs.self.darwinModules.base
          inputs.self.darwinModules.caching
          inputs.home-manager.darwinModules.home-manager
          inputs.self.darwinModules.home-manager
        ];
      };

      darwinModules = {
        base = { pkgs, ... }: import ./nix-darwin/base {
          inherit pkgs;
          overlays = [
            inputs.nuenv.overlays.default
            inputs.self.overlays.default
          ];
        };

        caching = { ... }: import ./nix-darwin/caching {
          inherit caches username;
        };

        # home-manager = { pkgs, ... }: import ./home-manager {
        #   inherit pkgs stateVersion username;
        # };
      };

      nixosConfigurations = rec {
        default = simple;

        simple = inputs.nixpkgs.lib.nixosSystem {
          system = "aarch64-linux";
          modules = [ ./nixos/configuration.nix ./nixos/hardware-configuration.nix ];
        };
      };
    };
}
