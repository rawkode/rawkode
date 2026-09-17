{
  flake.nixosModules.disk-common =
    { lib, ... }:
    {
      boot.loader.efi = {
        canTouchEfiVariables = lib.mkDefault true;
        efiSysMountPoint = lib.mkDefault "/boot";
      };
      fileSystems."/".options = [
        "noatime"
        "nodiratime"
      ];
    };
}
