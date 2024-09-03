{ config, pkgs, ... }:
{
  boot = {
    consoleLogLevel = 0;

    kernelPackages = pkgs.linuxPackages_zen;
    kernelParams = [ "video4linux" ];
    kernelModules = [
      "v4l2loopback"
    ];

    initrd = {
      systemd.enable = true;
      supportedFilesystems = [ "btrfs" ];
    };

    loader = {
      efi.canTouchEfiVariables = true;
      systemd-boot.configurationLimit = 10;
      systemd-boot.consoleMode = "max";
      systemd-boot.enable = true;
      systemd-boot.memtest86.enable = true;
      timeout = 10;
    };

    extraModulePackages = with config.boot.kernelPackages; [ v4l2loopback ];

    plymouth.enable = true;
    tmp.cleanOnBoot = true;
  };

  console.useXkbConfig = true;
}
