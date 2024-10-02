{ pkgs, ... }:
{
  services.flatpak = {
    packages = [
      {
        origin = "flathub";
        appId = "app.devsuite.Ptyxis";
      }
    ];
  };

  home.file.".var/app/app.devsuite.Ptyxis/config/glib-2.0/settings/keyfile" = {
    force = true;
    text = ''
    [org/gnome/Ptyxis]
    profile-uuids=['rawkode']
    default-profile-uuid='rawkode'
    new-tab-position='next'
    use-system-font=false
    font-name='MonaspiceNe Nerd Font Mono Regular 16'

    [org/gnome/Ptyxis/Profiles/rawkode]
    label='Rawkode'
    palette='Catppuccin Frappé'
    bold-is-bright=true
    # use-custom-command=true
    # custom-command='fish'
    preserve-container='never'
  '';
  };
}
