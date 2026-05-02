{
  flake.nixosModules.tailscale =
    {
      config,
      pkgs,
      ...
    }:
    {
      services.tailscale = {
        enable = true;
        useRoutingFeatures = "client";
        extraUpFlags = [ "--accept-dns=false" ];
        extraSetFlags = [
          "--accept-dns=false"
          "--ssh=true"
        ];
      };

      networking.firewall = {
        checkReversePath = "loose";
        trustedInterfaces = [ "tailscale0" ];
        allowedUDPPorts = [ config.services.tailscale.port ];
      };

      environment.systemPackages = with pkgs; [
        tailscale
      ];
    };

  flake.darwinModules.tailscale =
    {
      pkgs,
      ...
    }:
    {
      services.tailscale.enable = true;

      environment.systemPackages = [ pkgs.tailscale ];

      launchd.daemons.tailscale-ssh = {
        serviceConfig = {
          Label = "com.rawkode.tailscale-ssh";
          ProgramArguments = [
            "${pkgs.tailscale}/bin/tailscale"
            "set"
            "--ssh=true"
            "--accept-dns=false"
          ];
          RunAtLoad = true;
          KeepAlive.SuccessfulExit = false;
        };
      };
    };
}
