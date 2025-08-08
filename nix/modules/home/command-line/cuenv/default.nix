{ inputs
, pkgs
, ...
}:
{
  home.packages = (with pkgs; [ inputs.cuenv.packages.${system}.cuenv ]);
}
