{
  description = "Enchiridion Cloudflare second brain";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bash
            bun
            coreutils
            curl
            git
            nodejs_24
          ];

          shellHook = ''
            export npm_config_script_shell="${pkgs.bash}/bin/sh"
          '';
        };
      });
}
