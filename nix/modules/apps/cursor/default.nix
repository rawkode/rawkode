{
  flake.nixosModules.cursor = _: { };

  flake.darwinModules.cursor =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "cursor" ];
      };
    };
}
