{
  lib,
  ...
}:
with lib;
{
        home.persistence."/persist/home" = {
        directories = [ ".config/1Password" ];
      };

  dconf.settings = {
    "org/gnome/settings-daemon/plugins/media-keys" = {
      custom-keybindings = [
        "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom-1p/"
      ];
    };

    "org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom-1p" = {
      binding = "<Super>period";
      command = "1password --quick-access";
      name = "Search 1Password";
    };
  };
}
