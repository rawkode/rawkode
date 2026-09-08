{
  flake.darwinModules.macos-system-defaults-keyboard =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults.keyboard = {
        keyRepeat = lib.mkOption {
          type = lib.types.int;
          default = 2;
          description = "Key repeat rate";
        };
        initialKeyRepeat = lib.mkOption {
          type = lib.types.int;
          default = 15;
          description = "Delay before key repeat starts";
        };
        disablePressAndHold = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Use key repeat instead of accent selection";
        };
        fnUsageType = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Function-key behavior, or null for the system default";
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults.NSGlobalDomain = {
          KeyRepeat = cfg.keyboard.keyRepeat;
          InitialKeyRepeat = cfg.keyboard.initialKeyRepeat;
          ApplePressAndHoldEnabled = !cfg.keyboard.disablePressAndHold;
        };
      };
    };
}
