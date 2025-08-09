{ ... }:
{
  projectRootFile = "flake.nix";

  programs = {
    biome.enable = true;
    prettier.enable = true;
    nixpkgs-fmt.enable = true;
    shfmt.enable = true;
    taplo.enable = true;
    yamlfmt.enable = true;
  };

  settings.formatter.biome.excludes = [
    "**/waybar/style.css"
  ];
}
