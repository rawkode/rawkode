{
  flake.nixosModules.android =
    { pkgs, ... }:
    {
      environment.systemPackages = with pkgs; [
        android-tools
        scrcpy
      ];

      # 39705 for wireless ADB.
      networking.firewall = {
        enable = true;
        allowedTCPPorts = [ 39705 ];
        allowedUDPPorts = [ 39705 ];
      };
    };
}
