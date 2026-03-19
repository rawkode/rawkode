{
  flake.nixosModules.ice = _: { };

  flake.darwinModules.ice =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "jordanbaird-ice" ];
      };
    };
}
