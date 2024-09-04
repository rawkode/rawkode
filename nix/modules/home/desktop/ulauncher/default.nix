{ config, pkgs, ... }:
{
  dconf.settings = {
    "org/pantheon/desktop/gala/behavior" = {
      overlay-action = "${pkgs.ulauncher}/bin/ulauncher-toggle";
    };
    "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0" = {
      name = "Ulauncher";
      command = "ulauncher-toggle";
      binding = "<Super>space";
    };
  };

  home = {
    packages = with pkgs; [ ulauncher ];

    file = {
      "${config.xdg.configHome}/ulauncher/settings.json".text = ''
        {
          "clear-previous-query": true,
          "disable-desktop-filters": false,
          "grab-mouse-pointer": false,
          "hotkey-show-app": "null",
          "render-on-screen": "mouse-pointer-monitor",
          "show-indicator-icon": true,
          "show-recent-apps": "0",
          "terminal-command": "",
          "theme-name": "dark"
        }
      '';

      "${config.xdg.configHome}/autostart/ulauncher.desktop".text = ''
        [Desktop Entry]
        Name=Ulauncher
        Comment=Application launcher for Linux
        GenericName=Launcher
        Categories=GNOME;GTK;Utility;
        TryExec=${pkgs.ulauncher}/bin/ulauncher
        Exec=env GDK_BACKEND=x11 ${pkgs.ulauncher}/bin/ulauncher --hide-window --hide-window
        Icon=ulauncher
        Terminal=false
        Type=Application
        X-GNOME-Autostart-enabled=true
      '';
    };
  };
}
