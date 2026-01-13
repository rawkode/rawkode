# Common disko configuration for encrypted Btrfs setup
_: {
  flake.nixosModules.disko-btrfs-encrypted =
    { config, lib, ... }:
    {
      options.rawkOS.disko = {
        device = lib.mkOption {
          type = lib.types.str;
          default = "/dev/nvme0n1";
          description = "Primary storage device path";
        };
      };

      config = {
        disko.devices = {
          disk = {
            root = {
              type = "disk";
              inherit (config.rawkOS.disko) device;
              content = {
                type = "gpt";
                partitions = {
                  ESP = {
                    priority = 1;
                    name = "esp";
                    size = "512M";
                    type = "EF00";
                    content = {
                      type = "filesystem";
                      format = "vfat";
                      mountpoint = "/boot";
                      mountOptions = [ "defaults" ];
                    };
                  };

                  luks = {
                    size = "100%";
                    content = {
                      type = "luks";
                      name = "encrypted";

                      askPassword = true;

                      extraFormatArgs = [
                        "--type luks2"
                        "--cipher aes-xts-plain64"
                        "--hash sha512"
                        "--iter-time 5000"
                        "--key-size 256"
                        "--pbkdf argon2id"
                        "--use-random"
                      ];

                      settings = {
                        allowDiscards = true;
                      };

                      content = {
                        type = "btrfs";
                        extraArgs = [ "-f" ];
                        subvolumes = {
                          "@root" = {
                            mountpoint = "/";
                            mountOptions = [
                              "compress=zstd"
                              "noatime"
                            ];
                          };

                          "@persist" = {
                            mountpoint = "/persist";
                            mountOptions = [
                              "compress=zstd"
                              "noatime"
                            ];
                          };

                          "@nix" = {
                            mountpoint = "/nix";
                            mountOptions = [
                              "compress=zstd"
                              "noatime"
                            ];
                          };
                        };
                      };
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
