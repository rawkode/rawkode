{
  flake.darwinModules.cursor =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "cursor" ];
      };
    };
}
