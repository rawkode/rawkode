{
  flake.nixosModules.common =
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
        chrony = {
          enable = true;
          servers = [
            "time.cloudflare.com"
            "time.google.com"
          ];
          enableNTS = true;
        };
        fwupd.enable = true;
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
        udev.packages = with pkgs; [ ];
      };

      programs = {
        fish.enable = true;
        git.enable = true;
        kdeconnect.enable = true;
      };

      environment = {
        systemPackages = with pkgs; [
          coreutils-full
          git
        ];

        variables = {
          EDITOR = "hx";
          SYSTEMD_EDITOR = "hx";
          VISUAL = "hx";
        };
      };
    };
}
