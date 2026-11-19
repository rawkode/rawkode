{
  flake.nixosModules.audio =
    { pkgs, ... }:
    {
      environment.systemPackages = with pkgs; [
        pwvucontrol
      ];

      services.pipewire = {
        enable = true;

        alsa.enable = true;
        alsa.support32Bit = true;
        pulse.enable = true;
        wireplumber.enable = true;

        extraConfig.pipewire."92-low-latency" = {
          context.properties = {
            default.clock.rate = 48000;
            default.clock.quantum = 1024;
            default.clock.min-quantum = 32;
            default.clock.max-quantum = 2048;
          };
        };
      };

      security.rtkit.enable = true;
    };
}
