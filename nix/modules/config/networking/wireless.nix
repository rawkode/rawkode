{ inputs, ... }:
{
  flake.nixosModules.wireless =
    { lib, ... }:
    {
      networking.wireless = {
        enable = lib.mkForce false; # iwd owns Wi-Fi, not wpa_supplicant.
        iwd = {
          enable = true;
          settings.Network = {
            NameResolvingService = "systemd";
            EnableIPv6 = true;
          };
        };
      };
    };

  flake.machineTraits.nixos-wireless.nixos = [ inputs.self.nixosModules.wireless ];
}
