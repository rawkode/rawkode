{ config, lib, ... }:
let
  inherit (lib) mkOption types;
  cfg = config.rawkOS.hardware;
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
}
