# Wallpapers package - Dendritic pattern
{
  # Define wallpapers package per system
  perSystem =
    { pkgs, ... }:
    {
      packages.wallpapers = pkgs.stdenvNoCC.mkDerivation {
        pname = "wallpapers";
        version = "1.0";

        src = ./.;

        installPhase = ''
          mkdir -p $out
          cp *.png $out/ 2>/dev/null || true
        '';
      };
    };
}
