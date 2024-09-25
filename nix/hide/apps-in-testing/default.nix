{ ... }:
{
  services.flatpak = {
    remotes = [
      {
        name = "flathub";
        location = "https://flathub.org/repo/flathub.flatpakrepo";
      }
    ];
    packages = [
      {
        origin = "flathub";
        appId = "com.jeffser.Alpaca";
      }
      {
        origin = "flathub";
        appId = "org.ferdium.Ferdium";
      }
      {
        origin = "flathub";
        appId = "org.nickvision.tubeconverter";
      }
      {
        origin = "flathub";
        appId = "org.gnome.gitlab.somas.Apostrophe";
      }
      {
        origin = "flathub";
        appId = "io.github.nokse22.teleprompter";
      }
      {
        origin = "flathub";
        appId = "io.gitlab.adhami3310.Converter";
      }
      {
        origin = "flathub";
        appId = "io.github.halfmexican.Mingle";
      }
      {
        origin = "flathub";
        appId = "io.github.dvlv.boxbuddyrs";
      }
      {
        origin = "flathub";
        appId = "com.github.marhkb.Pods";
      }
      {
        origin = "flathub";
        appId = "com.feaneron.Boatswain";
      }
      {
        origin = "flathub";
        appId = "io.github.seadve.Kooha";
      }
      {
        origin = "flathub";
        appId = "com.mardojai.ForgeSparks";
      }
    ];
  };
}
