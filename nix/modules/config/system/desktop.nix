{
  flake.nixosModules.desktop-common = _: {
    # Installs KDE Connect and opens its firewall ports. The shells' phone
    # widgets drive it through `kdeconnect-cli` and the org.kde.kdeconnect
    # D-Bus API, which D-Bus-activates kdeconnectd on first use.
    programs.kdeconnect.enable = true;
    services.xserver.xkb.layout = "us";
    services.upower.enable = true;
  };
}
