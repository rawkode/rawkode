{
  flake.nixosModules.descript = _: { };

  flake.darwinModules.descript =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "descript" ];
      };
    };
}
