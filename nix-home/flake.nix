{
  description = "Rawkode's Nix Configuration";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.2311.*.tar.gz";

    nix-darwin = {
      url = "github:LnL7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "https://flakehub.com/f/nix-community/home-manager/0.2311.*.tar.gz";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs:
    let
      supportedSystems = [ "aarch64-darwin" ];
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
              rnix-lsp
              reload
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

      darwinConfigurations."P4X-Studio" = inputs.nix-darwin.lib.darwinSystem {
        inherit system;

        modules = [
          inputs.self.darwinModules.base
          inputs.self.darwinModules.caching
          inputs.home-manager.darwinModules.home-manager
          inputs.self.darwinModules.home-manager
        ];
      };

      darwinConfigurations."P4X-Air" = inputs.nix-darwin.lib.darwinSystem {
        inherit system;

        modules = [
          inputs.self.darwinModules.base
          inputs.self.darwinModules.caching
          inputs.home-manager.darwinModules.home-manager
          inputs.self.darwinModules.home-manager
        ];
      };

      darwinModules = {
        base = { pkgs, ... }: import ./nix-darwin {
          inherit pkgs;
          overlays = [
            inputs.self.overlays.default
          ];
        };

        caching = { ... }: import ./nix-darwin/caching.nix {
          inherit caches username;
        };

        home-manager.home-manager = {
          useGlobalPkgs = true;
          useUserPackages = true;

          users.${username} = { pkgs, username, ... }: import ./home-manager.nix {
						inherit pkgs username stateVersion;
					};
        };
      };
    };
}
