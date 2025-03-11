{ ... }:
{
  specialisation = {
    cosmic.configuration = {
      environment.etc."specialisation".text = "cosmic";
      system.nixos.tags = [ "cosmic" ];

      # Ensure GNOME is disabled
      services.xserver = {
        enable = true;
        desktopManager.gnome.enable = false;
        displayManager.gdm.enable = false;
      };

      services.desktopManager.cosmic.enable = true;
      services.displayManager.cosmic-greeter.enable = true;
    };
  };
}
