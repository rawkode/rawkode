{
  flake.nixosModules.dockdoor = _: { };

  flake.darwinModules.dockdoor =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "dockdoor" ];
      };
    };
}
