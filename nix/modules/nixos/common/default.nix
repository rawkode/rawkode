{ pkgs, ... }:
{
  fileSystems."/".options = [
    "noatime"
    "nodiratime"
  ];

  i18n = {
    defaultLocale = "en_GB.UTF-8";
  };

  services = {
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
    smartd.enable = true;
    udev.packages = with pkgs; [ gnome.gnome-settings-daemon ];
  };

  programs = {
    command-not-found.enable = false;
    fish.enable = true;
    git.enable = true;
    kdeconnect.enable = true;
    zsh.enable = true;
  };

  environment = {
    systemPackages = with pkgs; [
      coreutils-full
      git
      glib.dev
      gnome.gnome-tweaks
      pinentry-gnome3
    ];

    variables = {
      EDITOR = "code";
      SYSTEMD_EDITOR = "code";
      VISUAL = "code";
    };
  };

  time.timeZone = "Europe/London";
}
