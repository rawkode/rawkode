{
  flake.nixosModules.lact =
    { pkgs, ... }:
    {
      environment.systemPackages = with pkgs; [
        lact
      ];

      # Enable the lact daemon service
      systemd.services.lactd = {
        description = "LACT - Linux AMDGPU Control Daemon";
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          Type = "simple";
          ExecStart = "${pkgs.lact}/bin/lact daemon";
          Restart = "always";
          RestartSec = 5;
        };
      };
    };
}
