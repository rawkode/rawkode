{
  flake.darwinModules.fastmail =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "fastmail" ];
      };
    };
}
