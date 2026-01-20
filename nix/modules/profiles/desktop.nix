{ inputs, ... }:
{
  flake.nixosModules.profiles-desktop =
    { ... }:
    {
      imports = [
        inputs.self.nixosModules.profiles-base

        inputs.self.nixosModules.audio
        inputs.self.nixosModules.bluetooth
        inputs.self.nixosModules.desktop-common
        inputs.self.nixosModules.flatpak
        inputs.self.nixosModules.fonts
        inputs.self.nixosModules.gnome
        inputs.self.nixosModules.google-chrome
        inputs.self.nixosModules.location
        inputs.self.nixosModules.niri
        inputs.self.nixosModules.onepassword
        inputs.self.nixosModules.plymouth
        inputs.self.nixosModules.polkit
        inputs.self.nixosModules.portals
      ];

      config = {
        services = {
          pipewire = {
            enable = true;
            alsa.enable = true;
            pulse.enable = true;
          };
          printing.enable = true;
        };
      };
    };

  # NOTE: App imports have been removed from this profile.
  # Apps should now be managed via the `apps` parameter in mkUser.
  flake.homeModules.profiles-desktop = _: {
    # Infrastructure-level desktop home-manager settings can go here
  };
}
