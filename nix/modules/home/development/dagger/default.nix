{ inputs
, lib
, namespace
, pkgs
, ...
}:
with lib;
with lib.${namespace};
{
  home.packages = (with pkgs; [ inputs.dagger.packages.${system}.dagger ]);
}
