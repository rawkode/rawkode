{ lib, pkgs, ... }:

{
  imports = [ /etc/nixos/hardware-configuration.nix ];

  nix = {
    gc = {
      automatic = true;
      dates = "daily";
      options = "--delete-older-than 7d";
    };

    settings = {
      sandbox = true;
      trusted-users = [ "rawkode" ];
      experimental-features = [
        "nix-command"
        "flakes"
      ];
    };

    package = pkgs.nixVersions.git;
  };

  services.fwupd.enable = true;

  systemd = {
    user.services.polkit-gnome-authentication-agent-1 = {
      description = "polkit-gnome-authentication-agent-1";
      wantedBy = [ "graphical-session.target" ];
      wants = [ "graphical-session.target" ];
      after = [ "graphical-session.target" ];
      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
        Restart = "on-failure";
        RestartSec = 1;
        TimeoutStopSec = 10;
      };
    };
  };

  nixpkgs.config = {
    allowUnfree = true;
  };

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

    tmp.cleanOnBoot = true;
  };

  i18n = {
    defaultLocale = "en_GB.UTF-8";
  };

  networking = {
    hostName = "p4x-nixos";

    firewall = rec {
      allowedTCPPortRanges = [
        # KDE Connect
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
    powerOnBoot = true;
    settings.General.Experimental = true; # for gnome-bluetooth percentage
  };

  programs._1password.enable = true;
  programs._1password-gui = {
    enable = true;
    polkitPolicyOwners = [ "rawkode" ];
  };

  services.xserver.displayManager.gdm.enable = true;
  services.xserver.displayManager.gdm.wayland = true;

  programs.dconf.profiles.gdm.databases = [
    { settings."org/gnome/login-screen".enable-fingerprint-authentication = false; }
  ];

  virtualisation.containers.enable = true;
  virtualisation = {
    podman = {
      enable = true;
      dockerCompat = true;
      defaultNetwork.settings.dns_enabled = true;
    };
  };

  environment.systemPackages = with pkgs; [
    dive
    podman-tui
    docker-compose
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
  services.pipewire.enable = true;
  services.pipewire.pulse.enable = true;
  services.pipewire.wireplumber.enable = true;

  time.timeZone = "Europe/London";

  fonts = {
    fontDir = {
      enable = true;
    };

    enableDefaultPackages = true;

    fontconfig = {
      antialias = true;
      hinting.enable = true;
      hinting.autohint = true;
    };

    packages = with pkgs; [
      corefonts
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
    enable = false;
    package = pkgs.pulseaudioFull;
  };

  console.useXkbConfig = true;

  security.pam.services.gdm.enableGnomeKeyring = true;
  services.gnome.gnome-keyring.enable = true;

  services.udev.packages = with pkgs; [
    gnome.gnome-settings-daemon
    pkgs.espanso-wayland
  ];

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

  services.xserver = {
    enable = true;
    xkb.layout = "us";
    videoDrivers = [ "modesetting" ];

    desktopManager.gnome.enable = true;
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

  # I'd love for this to live in home-manager,
  # but espanso on wayland needs this additional
  # capability
  # security.wrappers.espanso = {
  #   source = "${pkgs.espanso-wayland}/bin/espanso";
  #   capabilities = "cap_dac_override+p";
  #   owner = "root";
  #   group = "root";
  # };

  # services.espanso.enable = true;
  # services.espanso.wayland = true;
  # systemd.user.services.espanso.serviceConfig.ExecStart = lib.mkForce "/run/wrappers/bin/espanso worker";

  programs.git.enable = true;
  programs.fish.enable = true;

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
    shell = pkgs.fish;
  };

  system.stateVersion = "23.11";
}
