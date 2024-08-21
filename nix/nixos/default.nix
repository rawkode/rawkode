{
  config,
  hostname,
  inputs,
  lib,
  modulesPath,
  pkgs,
  stateVersion,
  username,
  ...
}:
{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")

    inputs.catppuccin.nixosModules.catppuccin
    inputs.home-manager.nixosModules.default

    ./hardware/${hostname}
    ./networking
    ./nix
    ./programs
    ./secureboot
    ./system
  ];

  boot = {
    consoleLogLevel = 0;

    # Kernel 6.10.5 breaks all my GUI/wayland.
    # Wait for next
    kernelPackages = pkgs.stable.linuxPackages_zen;
    kernelParams = [ "video4linux" ];
    kernelModules = [ "v4l2loopback" ];

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

    extraModulePackages = with config.boot.kernelPackages; [
      # evdi
      v4l2loopback
    ];

    plymouth.enable = true;
    tmp.cleanOnBoot = true;
  };

  catppuccin = {
    enable = true;
    flavor = "mocha";
    accent = "mauve";
  };

  console.useXkbConfig = true;

  documentation.enable = true;
  documentation.nixos.enable = false;
  documentation.man.enable = true;
  documentation.info.enable = false;
  documentation.doc.enable = false;

  environment = {
    defaultPackages = with pkgs; lib.mkForce [ coreutils-full ];

    systemPackages = with pkgs; [
      git
      pinentry-gnome3
    ];

    variables = {
      EDITOR = "code";
      SYSTEMD_EDITOR = "code";
      VISUAL = "code";
    };
  };

  fileSystems."/".options = [
    "noatime"
    "nodiratime"
  ];

  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;

    # Bluetooth device battery percentage display
    settings.General.Experimental = true;
  };
  services.blueman.enable = true;

  i18n = {
    defaultLocale = "en_GB.UTF-8";
  };

  services = {
    flatpak.enable = true;
    fwupd.enable = true;
    gnome.gnome-keyring.enable = true;
    hardware.bolt.enable = true;
    libinput = {
      enable = true;

      touchpad = {
        naturalScrolling = true;
        scrollMethod = "twofinger";
        tapping = true;
        clickMethod = "clickfinger";
        disableWhileTyping = true;
      };

      mouse = {
        naturalScrolling = true;
        scrollMethod = "twofinger";
        tapping = true;
        clickMethod = "clickfinger";
        disableWhileTyping = true;
      };
    };
    printing.enable = true;
    pcscd.enable = true;
    resolved = {
      enable = true;
      dnsovertls = "opportunistic";
    };
    smartd.enable = true;
    udev.packages = with pkgs; [ gnome.gnome-settings-daemon ];
  };

  systemd.tmpfiles.rules = [ "d /nix/var/nix/profiles/per-user/${username} 0755 ${username} root" ];

  system = {
    inherit stateVersion;
  };

  time.timeZone = "Europe/London";

  users.groups.rawkode = { };

  users.users.rawkode = {
    isNormalUser = true;
    home = "/home/rawkode";
    description = "David Flanagan";
    extraGroups = [
      "rawkode"
      "audio"
      "disk"
      "docker"
      "input"
      "networkmanager"
      "plugdev"
      "wheel"
    ];
    shell = pkgs.fish;
  };
}
