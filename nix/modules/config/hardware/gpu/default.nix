{
  flake.nixosModules.hardware-gpu =
    { lib, ... }:
    let
      inherit (lib) mkOption types;
    in
    {
      options.rawkOS.hardware.gpu = mkOption {
        description = "GPU Manufacturer";
        default = null;
        type = types.nullOr (
          types.enum [
            "amd"
          ]
        );
      };
    };
}
