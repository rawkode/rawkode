{
  flake.darwinModules.warp =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "warp" ];
      };
    };
}
