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

  # Ptyxis keeps changing this and it's not hard to configure
  # home.file.".var/app/app.devsuite.Ptyxis/config/glib-2.0/settings/keyfile".text = ''
  #   [org/gnome/Ptyxis]
  #   profile-uuids=['rawkode']
  #   default-profile-uuid='rawkode'
  #   new-tab-position='next'
  #   use-system-font=false
  #   font-name='Liberation Mono 24'

  #   [org/gnome/Ptyxis/Profiles/rawkode]
  #   label='Rawkode'
  #   palette='Catppuccin Frappé'
  #   bold-is-bright=true
  #   use-custom-command=true
  #   custom-command='zellij'
  #   preserve-container='never'
  # '';
}
