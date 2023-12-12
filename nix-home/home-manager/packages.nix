{ pkgs }:

let
  basic = with pkgs; [
    coreutils
    findutils
    tree
    unzip
    wget
    zstd
  ];

	 shells = with pkgs; [
    nushell
  ];
in
basic
++ shells
