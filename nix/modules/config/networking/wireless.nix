{ inputs, ... }:
{
  flake.nixosModules.wireless =
    { lib, ... }:
    {
      networking.wireless = {
        enable = lib.mkForce false; # iwd owns Wi-Fi, not wpa_supplicant.
        iwd = {
          enable = true;
          settings = {
            Network = {
              NameResolvingService = "systemd";
              EnableIPv6 = true;
            };
            # Dual-band SSIDs: prefer 5GHz when (re)connecting.
            Rank.BandModifier2_4GHz = 0.5;
          };
        };
      };
    };

  flake.machineTraits.nixos-wireless.nixos = [ inputs.self.nixosModules.wireless ];
}
