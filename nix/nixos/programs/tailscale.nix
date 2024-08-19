{ ... }:
let
  port = 41641;
in
{
  networking.firewall.allowedUDPPorts = [ port ];

  services.tailscale = {
    enable = true;
    port = port;
  };
}
