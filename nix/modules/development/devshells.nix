# Development shells - Dendritic pattern
{
  # Define development shells per system
  perSystem =
    { pkgs, ... }:
    {
      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          cue
          nh
          nixfmt
          nixpkgs-fmt
          nil
          nix-tree
          nix-diff
          starship
          statix
        ];

        env = {
          FLAKE_ROOT = "$PWD";
        };

        shellHook = ''
          echo "Welcome to rawkOS development shell!"
          echo "Run 'nix flake show' to see available outputs"
        '';
      };
    };
}
