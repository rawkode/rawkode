_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "flatpak";

  linux.system = _: {
    services.flatpak = {
      enable = true;
      packages = [
        "com.github.tchx84.Flatseal"
        "org.gnome.Showtime"
        "org.localsend.localsend_app"
      ];
    };

    # LocalSend discovery and transfer port.
    networking.firewall = {
      allowedTCPPorts = [ 53317 ];
      allowedUDPPorts = [ 53317 ];
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
