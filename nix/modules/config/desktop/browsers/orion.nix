{
  flake.darwinModules.orion =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "orion" ];
      };
    };
}
