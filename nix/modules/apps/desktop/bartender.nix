{
  flake.nixosModules.bartender = _: { };

  flake.darwinModules.bartender =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "bartender" ];
      };
    };
}
