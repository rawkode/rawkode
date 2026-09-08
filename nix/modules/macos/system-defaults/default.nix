{ inputs, ... }:
{
  flake.darwinModules.macos-system-defaults =
    { lib, ... }:
    {
      imports = [
        inputs.self.darwinModules.macos-system-defaults-dock
        inputs.self.darwinModules.macos-system-defaults-finder
        inputs.self.darwinModules.macos-system-defaults-global
        inputs.self.darwinModules.macos-system-defaults-keyboard
        inputs.self.darwinModules.macos-system-defaults-mail
        inputs.self.darwinModules.macos-system-defaults-menu-bar
        inputs.self.darwinModules.macos-system-defaults-screencapture
        inputs.self.darwinModules.macos-system-defaults-window-manager
        inputs.self.darwinModules.macos-system-defaults-trackpad
      ];

      options.rawkOS.darwin.systemDefaults.enable =
        lib.mkEnableOption "macOS system defaults configuration";
    };
}
