{
  flake.homeModules.gnome-compiz =
    { pkgs, ... }:
    {

      dconf.settings = {
        "org/gnome/shell" = {
          enabled-extensions = [ "compiz-windows-effect@hermes83.github.com" ];
        };

        "org/gnome/shell/extensions/com/github/hermes83/compiz-windows-effect" = {
          resize-effect = true;

          friction = 4;
          spring-k = 4.0;
          mass = 32.0;
          speedup-factor-divider = 8;
        };
      };

      home.packages = with pkgs.gnomeExtensions; [ compiz-windows-effect ];

    };
}
