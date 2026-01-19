{
  flake.nixosModules.skim = _: { };

  flake.darwinModules.skim =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "skim" ];
      };
    };
}
