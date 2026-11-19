# Development shells - Dendritic pattern
{
  # Define development shells per system
  perSystem =
    { pkgs, ... }:
    {
      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          cue
          deadnix
          nh
          nixd
          nixfmt
          nix-tree
          nix-diff
          starship
          statix
        ];

        shellHook = ''
          export FLAKE_ROOT="$PWD"
          echo "Welcome to rawkOS development shell!"
          echo "Run 'nix flake show' to see available outputs"
        '';
      };
    };
}
