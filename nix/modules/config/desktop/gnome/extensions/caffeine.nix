{
  flake.homeModules.gnome-caffeine =
    { pkgs, ... }:
    {
      dconf.settings = {
        "org/gnome/shell" = {
          enabled-extensions = [ "caffeine@patapon.info" ];
        };

        "org/gnome/shell/extensions/caffeine" = {
          countdown-timer = 0;
          duration-timer = 2;
          enable-fullscreen = true;
          indicator-position-max = 2;
          restore-state = false;
          screen-blank = "never";
          show-timer = false;
        };
      };

      home.packages = with pkgs.gnomeExtensions; [ caffeine ];
    };
}
