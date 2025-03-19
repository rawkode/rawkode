{ ... }:
{
  specialisation = {
    plasma.configuration = {
      environment.etc."specialisation".text = "plasma";
      system.nixos.tags = [ "plasma" ];

			# Ensure GNOME is disabled
      services.xserver = {
        enable = true;
        desktopManager.gnome.enable = false;
        displayManager.gdm.enable = false;
      };

      services.desktopManager.plasma6.enable = true;
      services.displayManager.sddm.enable = true;
      services.displayManager.sddm.wayland.enable = true;
    };
  };
}
