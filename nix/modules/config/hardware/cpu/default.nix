_: {
  flake.nixosModules.hardware-cpu =
    { lib, ... }:
    let
      inherit (lib) mkOption types;
    in
    {
      options.rawkOS.hardware.cpu = mkOption {
        description = "CPU Manufacturer";
        default = null;
        type = types.nullOr (
          types.enum [
            "amd"
          ]
        );
      };
    };
}
