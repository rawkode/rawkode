{
  flake.homeModules.gnome-clipboard-indicator =
    { pkgs, ... }:
    {
      dconf.settings = {
        "org/gnome/shell" = {
          enabled-extensions = [ "clipboard-indicator@tudmotu.com" ];
        };

        "org/gnome/shell/extensions/clipboard-indicator" = {
          clear-on-boot = true;
          confirm-clear = false;
          display-mode = 0;
          enable-keybindings = false;
          history-size = 10;
          strip-text = true;
          toggle-menu = [ "<Super>c" ];
        };
      };

      home.packages = with pkgs.gnomeExtensions; [ clipboard-indicator ];
    };
}
