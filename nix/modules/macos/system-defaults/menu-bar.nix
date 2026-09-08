{
  flake.darwinModules.macos-system-defaults-menu-bar =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
      clockDateVisibility = {
        whenSpaceAllows = 0;
        always = 1;
        never = 2;
      };
    in
    {
      options.rawkOS.darwin.systemDefaults.menuBar.clock = {
        analog = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Show an analog clock instead of a digital clock";
        };
        use24Hour = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Use a 24-hour clock";
        };
        showAMPM = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Show the AM/PM label when using a 12-hour clock";
        };
        showDate = lib.mkOption {
          type = lib.types.enum [
            "whenSpaceAllows"
            "always"
            "never"
          ];
          default = "never";
          description = "When to show the date in the menu bar clock";
        };
        showDayOfMonth = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Show the day of the month in the menu bar clock";
        };
        showDayOfWeek = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Show the day of the week in the menu bar clock";
        };
        showSeconds = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Show seconds in the menu bar clock";
        };
        flashDateSeparators = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Flash the time separators in the menu bar clock";
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults.menuExtraClock = {
          FlashDateSeparators = cfg.menuBar.clock.flashDateSeparators;
          IsAnalog = cfg.menuBar.clock.analog;
          Show24Hour = cfg.menuBar.clock.use24Hour;
          ShowAMPM = cfg.menuBar.clock.showAMPM;
          ShowDate = clockDateVisibility.${cfg.menuBar.clock.showDate};
          ShowDayOfMonth = cfg.menuBar.clock.showDayOfMonth;
          ShowDayOfWeek = cfg.menuBar.clock.showDayOfWeek;
          ShowSeconds = cfg.menuBar.clock.showSeconds;
        };
      };
    };
}
