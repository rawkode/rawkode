{
  flake.darwinModules.macos-system-defaults-finder =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults.finder = {
        showExtensions = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Show all filename extensions";
        };
        showHiddenFiles = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Show hidden files";
        };
        showPathBar = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Show the path bar";
        };
        showStatusBar = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Show the status bar";
        };
        showPosixPath = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Show the full POSIX path in Finder titles";
        };
        defaultView = lib.mkOption {
          type = lib.types.enum [
            "icnv"
            "Nlsv"
            "clmv"
            "Flwv"
          ];
          default = "Nlsv";
          description = "Default Finder view style";
        };
        quitMenuItem = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Allow quitting Finder with Cmd+Q";
        };
        suggestFileNames = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Suggest file names from file and folder content";
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults = {
          finder = {
            AppleShowAllExtensions = cfg.finder.showExtensions;
            AppleShowAllFiles = cfg.finder.showHiddenFiles;
            ShowPathbar = cfg.finder.showPathBar;
            ShowStatusBar = cfg.finder.showStatusBar;
            _FXShowPosixPathInTitle = cfg.finder.showPosixPath;
            FXPreferredViewStyle = cfg.finder.defaultView;
            QuitMenuItem = cfg.finder.quitMenuItem;
          };

          NSGlobalDomain = {
            AppleShowAllExtensions = cfg.finder.showExtensions;
            AppleShowAllFiles = cfg.finder.showHiddenFiles;
          };

          CustomUserPreferences."com.apple.finder".NSSmartNamingDisabled = !cfg.finder.suggestFileNames;
        };
      };
    };
}
