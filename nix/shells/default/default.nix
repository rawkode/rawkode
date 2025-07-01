{ pkgs
, mkShell
, ...
}:

mkShell {
  packages = with pkgs; [
    biome
    nh
    nixfmt-rfc-style
  ];
}
