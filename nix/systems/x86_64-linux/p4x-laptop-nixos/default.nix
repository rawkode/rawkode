{ lib, pkgs, ... }:
let
  Minutes = x: x * 60;
in
{
  imports = [ ./hardware.nix ];

  rawkOS = {
    hardware = {
      cpu = "amd";
      gpu = "amd";
    };

    desktop = {
      wayland.force = true;
    };

    secureboot.enable = true;
  };

  systemd.services.NetworkManager-wait-online.enable = lib.mkForce false;
  systemd.services.systemd-networkd-wait-online.enable = lib.mkForce false;

  hardware.enableRedistributableFirmware = true;
  hardware.cpu.amd.updateMicrocode = true;
  hardware.keyboard.qmk.enable = true;
  hardware.graphics.enable = true;

  programs.dconf.enable = true;

  environment.systemPackages = with pkgs; [
    gnomeExtensions.battery-usage-wattmeter
    gnomeExtensions.battery-time
  ];

  # Powersaving Settings
  programs.auto-cpufreq = {
    enable = true;
    settings = {
      charger = {
        governor = "performance";
        turbo = "auto";
      };

      battery = {
        governor = "powersave";
        turbo = "never";
      };
    };
  };

  services = {
    power-profiles-daemon.enable = false;
    thermald.enable = true;

    upower = {
      enable = true;
      percentageLow = 15;
      percentageCritical = 7;
      percentageAction = 5;
      criticalPowerAction = "Hibernate";
    };
  };

  systemd.sleep.extraConfig = ''
    HibernateDelaySec=${toString (Minutes 10)}
  '';

  system.stateVersion = "25.05";
}
