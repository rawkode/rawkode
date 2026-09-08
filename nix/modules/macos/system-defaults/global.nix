{
  flake.darwinModules.macos-system-defaults-global =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults.global = {
        darkMode = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable dark mode";
        };
        autoSwitchTheme = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Automatically switch between light and dark mode";
        };
        reduceMotion = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Reduce user-interface motion";
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults.NSGlobalDomain = {
          AppleInterfaceStyle =
            if cfg.global.autoSwitchTheme then
              null
            else if cfg.global.darkMode then
              "Dark"
            else
              null;
          AppleInterfaceStyleSwitchesAutomatically = cfg.global.autoSwitchTheme;
          NSAutomaticWindowAnimationsEnabled = !cfg.global.reduceMotion;
        };
      };
    };
}
