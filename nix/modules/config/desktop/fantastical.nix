{
  flake.darwinModules.fantastical =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "fantastical" ];
      };
    };
}
