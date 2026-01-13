# Simple disko configuration for VMs (no encryption)
_: {
  flake.nixosModules.disko-vm-simple =
    { config, lib, ... }:
    {
      options.rawkOS.disko = {
        device = lib.mkOption {
          type = lib.types.str;
          default = "/dev/sda";
          description = "Primary storage device path";
        };
      };

      config = {
        disko.devices = {
          disk = {
            main = {
              type = "disk";
              inherit (config.rawkOS.disko) device;
              content = {
                type = "gpt";
                partitions = {
                  ESP = {
                    priority = 1;
                    name = "boot";
                    size = "512M";
                    type = "EF00";
                    content = {
                      type = "filesystem";
                      format = "vfat";
                      mountpoint = "/boot";
                      mountOptions = [ "defaults" "umask=0077" ];
                    };
                  };

                  root = {
                    size = "100%";
                    content = {
                      type = "filesystem";
                      format = "ext4";
                      mountpoint = "/";
                      mountOptions = [ "defaults" "noatime" ];
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
}
