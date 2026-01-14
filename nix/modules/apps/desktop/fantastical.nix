{
  flake.nixosModules.fantastical = _: { };

  flake.darwinModules.fantastical =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "fantastical" ];
      };
    };
}
