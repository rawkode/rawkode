{
  flake.darwinModules.power =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.power;
      sleepType = lib.types.either lib.types.ints.positive (lib.types.enum [ "never" ]);
    in
    {
      options.rawkOS.darwin.power = {
        enable = lib.mkEnableOption "macOS power management configuration";

        displaySleep = lib.mkOption {
          type = sleepType;
          default = 15;
          description = "Minutes until display sleeps (or 'never')";
        };

        computerSleep = lib.mkOption {
          type = sleepType;
          default = "never";
          description = "Minutes until computer sleeps (or 'never')";
        };

        harddiskSleep = lib.mkOption {
          type = sleepType;
          default = "never";
          description = "Minutes until hard disk sleeps (or 'never')";
        };

        allowSleepByPowerButton = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Allow pressing the power button to sleep the computer";
        };
      };

      config = lib.mkIf cfg.enable {
        power.sleep = {
          display = cfg.displaySleep;
          computer = cfg.computerSleep;
          harddisk = cfg.harddiskSleep;
        };
      };
    };
}
