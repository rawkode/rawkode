{
  flake.darwinModules.discord =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "discord" ];
      };
    };
}
