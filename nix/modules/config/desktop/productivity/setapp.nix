{
  flake.darwinModules.setapp =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "setapp" ];
      };
    };
}
