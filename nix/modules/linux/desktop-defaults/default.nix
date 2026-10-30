_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "desktop-defaults";

  # Services GNOME used to enable implicitly: trash, MTP and network mounts in
  # the file manager, plus removable-drive mounting.
  linux.system = _: {
    services.gvfs.enable = true;
    services.udisks2.enable = true;
  };

  linux.home =
    {
      lib,
      pkgs,
      ...
    }:
    let
      file-chooser = {
        date-format = "regular";
        location-mode = "path-bar";
        show-hidden = false;
        show-size-column = true;
        show-type-column = true;
        sidebar-width = 512;
        sort-column = "name";
        sort-directories-first = true;
        sort-order = "ascending";
        type-format = "category";
        view-type = "list";
      };
    in
    {
      gtk = {
        enable = true;

        gtk3.extraConfig = {
          gtk-decoration-layout = "menu:";
          gtk-xft-antialias = 1;
          gtk-xft-hinting = 1;
          gtk-xft-hintstyle = "hintfull";
          gtk-xft-rgba = "rgb";
          gtk-recent-files-enabled = false;
        };
      };

      # GTK/libadwaita apps and xdg-desktop-portal-gnome still read these keys
      # outside GNOME Shell.
      dconf.settings = {
        "org/gnome/desktop/interface" = {
          accent-color = "teal";
          enable-animations = true;
          font-hinting = lib.gvariant.mkString "slight";
          font-antialiasing = lib.gvariant.mkString "rgba";
        };

        "org/gnome/desktop/privacy" = {
          report-technical-problems = false;
        };

        "org/gnome/desktop/wm/preferences" = {
          button-layout = ":close";
        };

        "org/gtk/gtk4/settings/file-chooser" = file-chooser;
        "org/gtk/settings/file-chooser" = file-chooser;
      };

      home.packages = with pkgs; [
        cosmic-files
        decibels
        loupe
        papers
      ];

      # Explicit defaults so niri doesn't fall back to whichever app sorts first.
      # Showtime is installed from Flathub (see flatpak module).
      xdg.mimeApps = {
        enable = true;
        defaultApplications =
          let
            forTypes = app: types: lib.genAttrs types (_: [ app ]);
          in
          forTypes "com.system76.CosmicFiles.desktop" [ "inode/directory" ]
          // forTypes "org.gnome.Papers.desktop" [ "application/pdf" ]
          // forTypes "org.gnome.Loupe.desktop" [
            "image/avif"
            "image/bmp"
            "image/gif"
            "image/heic"
            "image/jpeg"
            "image/png"
            "image/svg+xml"
            "image/tiff"
            "image/webp"
          ]
          // forTypes "org.gnome.Showtime.desktop" [
            "video/mp4"
            "video/quicktime"
            "video/webm"
            "video/x-matroska"
            "video/x-msvideo"
          ]
          // forTypes "org.gnome.Decibels.desktop" [
            "audio/aac"
            "audio/flac"
            "audio/mp4"
            "audio/mpeg"
            "audio/ogg"
            "audio/wav"
            "audio/x-wav"
          ];
      };
    };
}
