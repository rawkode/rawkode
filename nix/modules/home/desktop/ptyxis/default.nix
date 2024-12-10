{ pkgs, ... }:
{
  home.packages = with pkgs; [
    ptyxis
  ];

  dconf.settings = {
    "org/gnome/Ptyxis" = {
      profile-uuids = [ "rawkode" ];
      default-profile-uuid = "rawkode";
      new-tab-position = "next";
      use-system-font = false;
      font-name = "MonaspiceAr Nerd Font Mono Regular 16";
    };

    "org/gnome/Ptyxis/Profiles/rawkode" = {
      label = "Rawkode";
      palette = "Catppuccin Mocha";
      bold-is-bright = true;
      preserve-container = "never";
    };
  };
}
