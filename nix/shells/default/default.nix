{
  lib,
  inputs,
  namespace,
  pkgs,
  mkShell,
  ...
}:

mkShell {
  packages = with pkgs; [
    nh
    nixfmt-rfc-style
  ];
}
