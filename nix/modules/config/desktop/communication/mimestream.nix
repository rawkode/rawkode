{
  flake.darwinModules.mimestream =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "mimestream" ];
      };
    };
}
