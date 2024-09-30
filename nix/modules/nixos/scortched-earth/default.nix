{ lib, ... }:
{
  fileSystems."/persist".neededForBoot = true;
   
  environment.persistence = {
  "/persist" = {
    directories = [
      "/etc/nixos"
      "/etc/NetworkManager/system-connections"
      "/var/lib/flatpak"
      "/var/lib/fprint"
      "/var/lib/systemd"
      "/var/lib/nixos"
      "/var/log"
      "/srv"
    ];
  };
};}