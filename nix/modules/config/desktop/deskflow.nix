{
  flake.darwinModules.deskflow =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        taps = [ "deskflow/tap" ];
        casks = [ "deskflow" ];
      };
    };
}
