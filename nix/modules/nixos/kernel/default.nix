{ config, lib, pkgs, ... }:
{
  boot = {
    consoleLogLevel = 0;

    kernelPackages = pkgs.linuxKernel.packages.linux_zen;
    kernelParams = [ "video4linux" ];
    kernelModules = [ "v4l2loopback" ];

    initrd = {
      systemd.enable = true;
      supportedFilesystems = [ "btrfs" ];
    };

    bootspec = {
      enable = true;
      enableValidation = true;
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

  networking.useNetworkd = true;
  systemd.services.systemd-networkd-wait-online.enable = lib.mkForce false;

  nix.channel.enable = false;

  console.useXkbConfig = true;
}
