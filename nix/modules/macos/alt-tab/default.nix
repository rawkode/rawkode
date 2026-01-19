{
  flake.nixosModules.alt-tab = _: { };

  flake.darwinModules.alt-tab =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "alt-tab" ];
      };
    };
}
