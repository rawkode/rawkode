{
  flake.nixosModules.wip-waydroid =
    { pkgs, ... }:
    {
      environment.systemPackages = with pkgs; [
        # Waydroid needs this for clipboard support
        python3Packages.pyclip
        python3Packages.setuptools
      ];

      virtualisation = {
        waydroid.enable = true;
      };
    };
}
