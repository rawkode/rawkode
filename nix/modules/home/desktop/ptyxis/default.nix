{ pkgs, ... }: {
  dconf.settings = {
    "org/gnome/Ptyxis" = {
      profile-uuids = [ "rawkode" ];
      default-profile-uuid = "rawkode";
      new-tab-position = "next";
      use-system-font = false;
      font-name = "MonaspiceNe Nerd Font Mono Regular 16";
    };

    "org/gnome/Ptyxis/Profiles/rawkode" = {
      label = "Rawkode";
      palette = "Catppuccin Frappé";
      bold-is-bright = true;
      preserve-container = "never";
    };
  };
}
