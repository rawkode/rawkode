{
  flake.nixosModules.raycast = _: { };

  flake.darwinModules.raycast =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "raycast" ];
      };
    };
}
