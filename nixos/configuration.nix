{ config, pkgs, ... }:

{
  imports = [
    ./hardware-configuration.nix
    <nixos-hardware/framework/13-inch/7040-amd>
  ];

  services.fwupd.enable = true;

  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  fileSystems."/".options = [
    "noatime"
    "nodiratime"
  ];

  boot = {
    kernelPackages = pkgs.linuxPackages_latest;

    loader = {
      systemd-boot = {
        enable = true;
      };

      efi = {
        canTouchEfiVariables = true;
      };
    };

    cleanTmpDir = true;
  };

  i18n = {
    defaultLocale = "en_GB.UTF-8";
  };

  networking = {
    hostName = "p4x-nixos";

    firewall = rec {
      allowedTCPPortRanges = [
        {
          from = 1714;
          to = 1764;
        }
      ];
      allowedUDPPortRanges = allowedTCPPortRanges;
    };

    networkmanager = {
      enable = true;
    };

    nameservers = [
      "1.1.1.1"
      "1.0.0.1"
    ];
  };

  # bluetooth
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = false;
    settings.General.Experimental = true; # for gnome-bluetooth percentage
  };

  nix = {
    gc = {
      automatic = true;
      dates = "daily";
      options = "--delete-older-than 7d";
    };

    useSandbox = true;

    package = pkgs.nixVersions.git;
  };

  programs._1password.enable = true;
  programs._1password-gui = {
    enable = true;
    polkitPolicyOwners = [ "rawkode" ];
  };

  environment.etc = {
    "1password/custom_allowed_browsers" = {
      text = ''
        vivaldi-bin
      '';
      mode = "0755";
    };
  };

  # Set your time zone.
  time.timeZone = "Europe/London";

  fonts = {
    enableFontDir = true;
    enableDefaultFonts = true;

    fontconfig = {
      antialias = true;
      hinting.enable = true;
      hinting.autohint = true;
    };

    packages = with pkgs; [
      corefonts
      displaylink
      emojione
      google-fonts
      merriweather
      monaspace
      quicksand
    ];

    fontconfig = {
      defaultFonts = {
        monospace = [ "Monaspace Neon" ];
        sansSerif = [ "Quicksand" ];
        serif = [ "Merriweather" ];
      };
    };
  };

  services.printing.enable = true;
  services.pcscd.enable = true;

  sound.enable = true;

  hardware.pulseaudio = {
    enable = true;
    package = pkgs.pulseaudioFull;
  };

  i18n.consoleUseXkbConfig = true;

  security.pam.services.gdm.enableGnomeKeyring = true;
  services.gnome.gnome-keyring.enable = true;

  services.udev.packages = with pkgs; [ gnome.gnome-settings-daemon ];

  programs.hyprland.enable = true;

  services.xserver = {
    enable = true;

    layout = "us";

    videoDrivers = [ "displaylink" "modesetting" ];

    displayManager = {
      defaultSession = "gnome";
      sddm.enable = false;
      gdm = {
        enable = true;
        wayland = true;
      };
    };

    desktopManager = {
      gnome.enable = true;
      plasma6.enable = false;
    };

    libinput = {
      enable = true;

      # This only applies to the trackpad, need to check if we
      # can find a way to do this for mice too.
      naturalScrolling = true;
      scrollMethod = "twofinger";
      tapping = true;
      clickMethod = "clickfinger";
      disableWhileTyping = true;
    };
  };

  environment.gnome.excludePackages = with pkgs; [
    gedit
    gnome.yelp
    gnome.file-roller
    gnome.geary
    gnome.gnome-maps
    gnome.gnome-music
    gnome-photos
    gnome.gnome-system-monitor
    gnome.gnome-weather

    gnomeExtensions.applications-menu
    gnomeExtensions.auto-move-windows
    gnomeExtensions.launch-new-instance
    gnomeExtensions.light-style
    gnomeExtensions.native-window-placement
    gnomeExtensions.places-status-indicator
    gnomeExtensions.removable-drive-menu
    gnomeExtensions.window-list
    gnomeExtensions.windownavigator
    gnomeExtensions.workspace-indicator
  ];

  nixpkgs.config = {
    allowUnfree = true;
  };

  programs.zsh.enable = true;
  programs.git.enable = true;

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
      "networkmanager"
      "plugdev"
      "wheel"
    ];
    shell = pkgs.zsh;
  };

  nix.trustedUsers = [ "rawkode" ];

  system.stateVersion = "23.11";
}
