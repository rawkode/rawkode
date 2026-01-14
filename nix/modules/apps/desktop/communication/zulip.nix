{
  flake.homeModules.zulip = {
    services.flatpak.packages = [
      "org.zulip.Zulip"
    ];
  };
}
