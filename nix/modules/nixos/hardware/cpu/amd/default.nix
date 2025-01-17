{ config, lib, ... }:
let
  inherit (lib.modules) mkIf;
  cfg = config.rawkOS.hardware;
in
{
  config = mkIf (cfg.cpu == "amd") {
    hardware.cpu.amd.updateMicrocode = true;

    boot.kernelModules = [
      "kvm-amd"
      "amd-pstate"
    ];
  };
}
