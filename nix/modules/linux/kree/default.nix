{
  flake.nixosModules.kree = _: { };

  flake.darwinModules.kree =
    { inputs, pkgs, ... }:
    {
      environment.systemPackages = [
        inputs.kree.packages.${pkgs.stdenv.hostPlatform.system}.default
      ];
    };
}
