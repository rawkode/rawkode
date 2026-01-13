{
  flake.nixosModules.amdctl =
    { pkgs, ... }:
    {
      environment.systemPackages = with pkgs; [
        amdctl
      ];

      # Allow amdctl to access MSR (Model Specific Registers)
      boot.kernelModules = [ "msr" ];
    };
}
