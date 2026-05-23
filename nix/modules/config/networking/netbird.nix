{
  flake.nixosModules.netbird =
    { pkgs, ... }:
    {
      services.netbird.enable = true;

      environment.systemPackages = with pkgs; [
        netbird
      ];
    };

  flake.darwinModules.netbird = {
    homebrew = {
      enable = true;
      taps = [ "netbirdio/tap" ];
      brews = [ "netbird" ];
      casks = [ "netbird-ui" ];
    };
  };
}
