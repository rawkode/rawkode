{ config, lib, ... }:
let
  inherit (lib) mkOption types;
  cfg = config.rawkOS.hardware;
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
}
