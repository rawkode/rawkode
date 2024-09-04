{ pkgs, ... }:
{
  catppuccin = {
    enable = true;
    flavor = "frappe";
    accent = "mauve";

    pointerCursor.enable = true;
    pointerCursor.flavor = "frappe";
    pointerCursor.accent = "mauve";
  };

  dconf.settings = {
    "org/gnome/desktop/interface" = {
      color-scheme = "prefer-dark";
    };
  };

  gtk = {
    enable = true;

    font = {
      name = "Cantarell";
      size = 12;
      package = pkgs.cantarell-fonts;
    };

    gtk3.extraConfig = {
      gtk-application-prefer-dark-theme = 1;
    };

    gtk4.extraConfig = {
      gtk-application-prefer-dark-theme = 1;
    };

    catppuccin = {
      flavor = "frappe";
      accent = "mauve";

      icon.enable = true;
      icon.flavor = "frappe";
      icon.accent = "mauve";
    };
  };
}
