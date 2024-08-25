{ pkgs, ... }:
{
  fileSystems."/".options = [
    "noatime"
    "nodiratime"
  ];

  i18n = {
    defaultLocale = "en_GB.UTF-8";
  };

  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;

    # Bluetooth device battery percentage display
    settings.General.Experimental = true;
  };
  services.blueman.enable = true;

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

  command-not-found.enable = false;
  dconf = {
    enable = true;
    profiles.gdm.databases = [
      { settings."org/gnome/login-screen".enable-fingerprint-authentication = true; }
    ];
  };
  fish.enable = true;
  git.enable = true;
  kdeconnect.enable = true;
  zsh.enable = true;

  time.timeZone = "Europe/London";
}
