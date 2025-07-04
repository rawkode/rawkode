{
  inputs,
  lib,
  namespace,
  pkgs,
  ...
}:
with lib;
with lib.${namespace};
{
  home.packages = (with pkgs; [ inputs.codex.packages.${system}.codex-rs ]);
}
