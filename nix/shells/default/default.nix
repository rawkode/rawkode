{ pkgs
, mkShell
, ...
}:

mkShell {
  packages = with pkgs; [
    biome
    cue
    nh
    nixfmt-rfc-style
  ];
}
