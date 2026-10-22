{
  flake.nixosModules.netbird =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      services.netbird.enable = true;

      environment.systemPackages = with pkgs; [
        netbird
      ];

      # Tray icon for the desktop session; only starts under a graphical session.
      # The client wrapper's netbird-ui already points at this client's daemon.
      systemd.user.services.netbird-ui = lib.mkIf config.services.netbird.ui.enable {
        description = "NetBird system tray";
        after = [ "graphical-session.target" ];
        partOf = [ "graphical-session.target" ];
        wantedBy = [ "graphical-session.target" ];
        serviceConfig = {
          ExecStart = "${config.services.netbird.clients.default.wrapper}/bin/netbird-ui";
          Restart = "on-failure";
        };
      };
    };

  flake.darwinModules.netbird = {
    homebrew = {
      enable = true;
      taps = [ "netbirdio/tap" ];
      brews = [ "netbirdio/tap/netbird" ];
      casks = [ "netbirdio/tap/netbird-ui" ];
    };
  };
}
