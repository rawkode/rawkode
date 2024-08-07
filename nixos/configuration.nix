{ lib, pkgs, ... }:

{
  imports = [
    ./substituters.nix
    ./modules/secureboot/default.nix
    ./system/default.nix
  ];

  nix = {
    gc = {
      automatic = true;
      dates = "daily";
      options = "--delete-older-than 7d";
    };

    settings = {
      sandbox = true;
      trusted-users = [ "rawkode" ];
      auto-optimise-store = true;
      builders-use-substitutes = true;

      experimental-features = [
        "nix-command"
        "flakes"
      ];

      # for direnv GC roots
      keep-derivations = true;
      keep-outputs = true;
    };

    package = pkgs.nixVersions.git;
  };

  catppuccin = {
    enable = true;
    flavor = "mocha";
    accent = "blue";
  };

  services.fwupd.enable = true;

  nixpkgs.config = {
    allowUnfree = true;
  };

  fileSystems."/".options = [
    "noatime"
    "nodiratime"
  ];

  boot = {
    kernelPackages = pkgs.linuxPackages_latest;

    initrd = {
      systemd.enable = true;
      supportedFilesystems = [ "btrfs" ];
    };

    loader = {
      efi = {
        canTouchEfiVariables = true;
      };
      systemd-boot.enable = true;
    };

    plymouth.enable = true;
    tmp.cleanOnBoot = true;
  };

  i18n = {
    defaultLocale = "en_GB.UTF-8";
  };

  networking = {
    # firewall = rec {
    #   allowedTCPPortRanges = [
    #     # KDE Connect
    #     {
    #       from = 1714;
    #       to = 1764;
    #     }
    #     # RQuickShare
    #     {
    #       from = 12345;
    #       to = 12345;
    #     }
    #   ];
    #   allowedUDPPortRanges = allowedTCPPortRanges;
    # };

    networkmanager = {
      enable = true;
      dns = "systemd-resolved";
    };

    nameservers = [
      "1.1.1.1"
      "1.0.0.1"
    ];
  };

  services.resolved = {
    enable = true;
    dnsovertls = "opportunistic";
  };

  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;

    # for gnome-bluetooth battery percentage
    settings.General.Experimental = true;
  };

  programs._1password.enable = true;
  programs._1password-gui = {
    enable = true;
    polkitPolicyOwners = [ "rawkode" ];
  };

  programs.kdeconnect.enable = true;

  programs.dconf = {
    enable = true;
    profiles.gdm.databases = [
      { settings."org/gnome/login-screen".enable-fingerprint-authentication = true; }
    ];
  };

  virtualisation = {
    containers.enable = true;

    lxc.enable = true;
    lxd.enable = true;

    podman = {
      enable = true;
      dockerCompat = true;
      defaultNetwork.settings.dns_enabled = true;
    };

    waydroid.enable = true;
  };

  environment.systemPackages = with pkgs; [
    podman-tui

    # Waydroid needs this for clipboard support
    python3Packages.pyclip
    python3Packages.setuptools
  ];

  environment.sessionVariables.NIXOS_OZONE_WL = "1";
  environment.etc = {
    "1password/custom_allowed_browsers" = {
      text = ''
        vivaldi-bin
      '';
      mode = "0755";
    };
  };

  security.rtkit.enable = true;

  time.timeZone = "Europe/London";

  services.printing.enable = true;
  services.pcscd.enable = true;

  console.useXkbConfig = true;

  security.pam.services.gdm.enableGnomeKeyring = true;
  services.gnome.gnome-keyring.enable = true;

  services.udev.packages = with pkgs; [ gnome.gnome-settings-daemon ];

  # Get around permission denied error on /dev/uinput
  # for espanso
  services.udev.extraRules = ''
    KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput", GROUP="input", MODE="0660"
  '';

  services.libinput = {
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

  programs.ssh.askPassword = lib.mkForce "${pkgs.seahorse}/libexec/seahorse/ssh-askpass";

  services.desktopManager = {
    plasma6.enable = false;
  };

  services.displayManager = {
      sddm.enable = false;
  };

  services.xserver = {
    enable = true;
    xkb.layout = "us";
    videoDrivers = [ "modesetting" ];

    desktopManager = {
      gnome.enable = true;
    };

    displayManager = {
      gdm = {
        enable = true;
        wayland = true;
      };
    };
  };

  environment.gnome.excludePackages = with pkgs; [
    geary
    gedit
    gnome-photos
    gnome-system-monitor
    gnome.gnome-maps
    gnome.gnome-music
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
    yelp
  ];

  # I'd love for this to live in home-manager,
  # but espanso on wayland needs this additional
  # capability
  security.wrappers.espanso = {
    source = "${pkgs.espanso-wayland}/bin/espanso";
    capabilities = "cap_dac_override+p";
    owner = "root";
    group = "root";
  };

  services.espanso.enable = true;
  systemd.user.services.espanso.serviceConfig.ExecStart = lib.mkForce "${pkgs.espanso-wayland}/bin/espanso worker";

  programs.fish.enable = true;
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
      "input"
      "networkmanager"
      "plugdev"
      "wheel"
    ];
    shell = pkgs.fish;
  };

  system.stateVersion = "24.05";
}
