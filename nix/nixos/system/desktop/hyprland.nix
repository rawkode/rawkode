{ lib, pkgs, ... }:
{
  programs.hyprland.enable = true;

  systemd.services.greetd.serviceConfig = {
    Type = "idle";
    StandardInput = "tty";
    StandardOutput = "tty";
    StandardError = "journal";
    TTYReset = true;
    TTYVHangup = true;
    TTYVTDisallocate = true;
  };

  xdg.portal = {
    enable = true;
    extraPortals = with pkgs; [
      xdg-desktop-portal-gtk
      xdg-desktop-portal-wlr
    ];
  };

  systemd = {
    user.services.polkit-gnome-authentication-agent-1 = {
      description = "polkit-gnome-authentication-agent-1";
      wantedBy = [ "graphical-session.target" ];
      wants = [ "graphical-session.target" ];
      after = [ "graphical-session.target" ];
      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
        Restart = "on-failure";
        RestartSec = 1;
        TimeoutStopSec = 10;
      };
    };
  };

  security = {
    pam.services.hyprlock = { };
    polkit.enable = true;
  };

  services = {
    gvfs.enable = true;
    devmon.enable = true;
    udisks2.enable = true;
    upower.enable = true;
    power-profiles-daemon.enable = true;
    accounts-daemon.enable = true;

    gnome = {
      evolution-data-server.enable = true;
      glib-networking.enable = true;
      gnome-keyring.enable = true;
      gnome-online-accounts.enable = true;
      tracker-miners.enable = true;
      tracker.enable = true;
    };

    greetd = {
      enable = true;
      settings = rec {
        tuigreet_session =
          let
            session = "${pkgs.hyprland}/bin/Hyprland";
            tuigreet = "${lib.getExe pkgs.greetd.tuigreet}";
          in
          {
            command = "${tuigreet} --time --remember --cmd ${session}";
            user = "greeter";
          };
        default_session = tuigreet_session;
      };
    };

    seatd.enable = true;

    displayManager = {
      defaultSession = "hyprland";
    };

    xserver.xkb.layout = "us";
  };

  environment.systemPackages = with pkgs; [
    brightnessctl
    gnome-calculator
    gnome-calendar
    gnome-system-monitor
    gnome.gnome-boxes
    gnome.gnome-clocks
    gnome.gnome-control-center
    gnome.gnome-software
    gnome.gnome-weather
    loupe
    nautilus
    wl-clipboard
    wl-gammactl
  ];

}
