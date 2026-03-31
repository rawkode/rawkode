{
  flake.nixosModules.netbird = _: { };

  flake.darwinModules.netbird =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        taps = [ "netbirdio/tap" ];
        casks = [ "netbirdio/tap/netbird-ui" ];
      };
    };
}
