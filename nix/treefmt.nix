{ ... }:
{
  projectRootFile = "flake.nix";

  programs = {
    biome.enable = true; # JSON
    mdformat.enable = true;
    nixpkgs-fmt.enable = true;
    shfmt.enable = true;
    taplo.enable = true;
    yamlfmt.enable = true;
  };
}
