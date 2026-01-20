{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "flatpak";

  linux.system = _: {
    services.flatpak = {
      enable = true;
      packages = [
        "com.core447.StreamController"
        "com.discordapp.Discord"
        "com.github.tchx84.Flatseal"
        "com.jeffser.Alpaca"
        "com.spotify.Client"
        "io.github.seadve.Kooha"
        "org.flameshot.Flameshot"
        "org.gnome.Showtime"
        "org.gnome.Snapshot"
        "org.localsend.localsend_app"
      ];
    };
  };

  linux.home = _: {
    services.flatpak = {
      enable = true;

      remotes = [
        {
          name = "flathub";
          location = "https://dl.flathub.org/repo/flathub.flatpakrepo";
        }
      ];

      packages = [
        "org.pipewire.Helvum"
      ];
    };
  };
}
