{
  config,
  lib,
  pkgs,
  ...
}:
{
  programs.hyprland = {
    enable = true;
    xwayland.enable = true;

    # Hyprland portal doesn't let me screenshare.
    # Maybe try again after 0.42
    portalPackage = pkgs.xdg-desktop-portal-wlr;
  };

  security = {
    pam.services = {
      hyprlock = { };
      gdm.enableGnomeKeyring = true;
      gdm-password.enableGnomeKeyring = true;
    };
    polkit.enable = true;
  };

  security.pam.services.login.fprintAuth = false;
  security.pam.services.gdm-fingerprint = lib.mkIf (config.services.fprintd.enable) {
    text = ''
      auth       required                    pam_shells.so
      auth       requisite                   pam_nologin.so
      auth       requisite                   pam_faillock.so      preauth
      auth       required                    ${pkgs.fprintd}/lib/security/pam_fprintd.so
      auth       optional                    pam_permit.so
      auth       required                    pam_env.so
      auth       [success=ok default=1]      ${pkgs.gnome.gdm}/lib/security/pam_gdm.so
      auth       optional                    ${pkgs.gnome-keyring}/lib/security/pam_gnome_keyring.so

      account    include                     login

      password   required                    pam_deny.so

      session    include                     login
      session    optional                    ${pkgs.gnome-keyring}/lib/security/pam_gnome_keyring.so auto_start
    '';
  };

  xdg = {
    portal = {
      enable = true;
      xdgOpenUsePortal = true;

      extraPortals = with pkgs; [
        xdg-desktop-portal-gnome
        xdg-desktop-portal-gtk
      ];

      config = {
        common = {
          default = [ "gtk" ];
        };

        hyprland = {
          default = [
            "wlr"
            "gnome"
            "gtk"
          ];

          "org.freedesktop.impl.portal.Secret" = [ "gnome-keyring" ];
        };
      };
    };
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

    displayManager.defaultSession = "hyprland";
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
    grim
    grimblast
    loupe
    nautilus
    wl-clipboard
    wl-gammactl
  ];
}
