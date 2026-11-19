{
  flake.nixosModules.common =
    { lib, pkgs, ... }:
    {
      i18n = {
        defaultLocale = "en_GB.UTF-8";
      };

      boot.tmp.cleanOnBoot = true;
      console.useXkbConfig = true;
      zramSwap.enable = lib.mkDefault true;

      services = {
        chrony = {
          enable = true;
          servers = [
            "time.cloudflare.com"
            "nts.netnod.se"
          ];
          enableNTS = true;
        };
      };

      programs = {
        fish.enable = true;
        git.enable = true;
      };

      environment.systemPackages = [ pkgs.coreutils-full ];
    };
}
