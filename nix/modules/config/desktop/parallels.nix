{
  flake.darwinModules.parallels =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "parallels" ];
      };
    };
}
