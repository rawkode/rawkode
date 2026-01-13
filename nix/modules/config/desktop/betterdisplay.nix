{
  flake.darwinModules.betterdisplay =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "betterdisplay" ];
      };
    };
}
