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

  macTools = with pkgs.darwin.apple_sdk.frameworks; [
    CoreServices
    Foundation
    Security
  ];

  nixTools = with pkgs; [
    fh
    flake-checker
    nixfmt
    nixpkgs-fmt
  ];

  shells = with pkgs; [
    nushell
  ];

  starship = import ./starship.nix { inherit pkgs; };
in
basic
++ macTools
++ misc
++ nixTools
++ shells
