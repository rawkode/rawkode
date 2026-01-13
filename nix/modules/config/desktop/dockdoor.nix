{
  flake.darwinModules.dockdoor =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "dockdoor" ];
      };
    };
}
