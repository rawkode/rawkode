{
  lib,
  osConfig ? { },
  pkgs,
  ...
}:
with lib;
let
  cfg = osConfig.rawkOS.desktop.gnome;
in
{
  config = mkIf cfg.enable {
    home.packages = with pkgs; [
      smile
      gnomeExtensions.smile-complementary-extension
    ];

    dconf.settings = {
      "org/gnome/shell" = {
        enabled-extensions = [ "smile-extension@mijorus.it" ];
      };

      "org/gnome/settings-daemon/plugins/media-keys" = {
        custom-keybindings = [
          "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom-smile/"
        ];
      };

      "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom-smile" = {
        binding = "<Super>e";
        command = "smile";
        name = "Open Smile";
      };
    };
  };
}
