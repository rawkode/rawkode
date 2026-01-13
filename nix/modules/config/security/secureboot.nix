{
  flake.nixosModules.lanzaboote =
    { lib, pkgs, ... }:
    {
      environment.systemPackages = with pkgs; [
        sbctl
        tpm2-tss
      ];

      boot = {
        # Lanzaboote currently replaces the systemd-boot module.
        # This setting is usually set to true in configuration.nix
        # generated at installation time. So we force it to false
        # for now.
        loader = {
          systemd-boot.enable = lib.mkForce false;
          efi.canTouchEfiVariables = lib.mkDefault true;
        };

        lanzaboote = {
          enable = true;
          pkiBundle = "/var/lib/sbctl";
        };
      };
    };
}
