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
    };
}
