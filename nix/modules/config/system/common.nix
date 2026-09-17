{
  flake.nixosModules.common =
    { pkgs, ... }:
    {
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
      };

      programs = {
        fish.enable = true;
        git.enable = true;
      };

      environment = {
        systemPackages = with pkgs; [
          coreutils-full
          git
        ];
      };
    };
}
