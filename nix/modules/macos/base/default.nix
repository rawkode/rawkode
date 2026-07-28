{ inputs, ... }:
{
  flake.darwinModules.macos-base =
    { lib, pkgs, ... }:
    {
      imports = [
        inputs.self.darwinModules.fonts
        inputs.self.darwinModules.macos-firewall
        inputs.self.darwinModules.macos-system-defaults
        inputs.self.darwinModules.power
      ];

      homebrew.onActivation.cleanup = "zap";

      programs.zsh.enable = true;
      environment.shells = [
        pkgs.zsh
        pkgs.bashInteractive
      ];

      security.pam.services.sudo_local.touchIdAuth = true;

      launchd.daemons.maxfiles.serviceConfig = {
        Label = "com.rawkode.maxfiles";
        ProgramArguments = [ "/usr/bin/true" ];
        RunAtLoad = true;
        SoftResourceLimits.NumberOfFiles = 1048576;
        HardResourceLimits.NumberOfFiles = 1048576;
      };

      rawkOS.darwin = {
        systemDefaults = {
          enable = true;
          dock = {
            autohide = true;
            autohideDelay = 0.0;
            autohideTimeModifier = 0.15;
            orientation = "bottom";
            tilesize = 44;
            launchanim = false;
            minimizeToApplication = true;
            showProcessIndicators = true;
            showRecents = false;
            persistentApps = [ ];
            exposeAnimationDuration = 0.2;
            exposeGroupApps = true;
            mruSpaces = false;
            appswitcherAllDisplays = false;
            hotCornerTopLeft = 1;
            hotCornerTopRight = 12;
            hotCornerBottomLeft = 1;
            hotCornerBottomRight = 4;
          };
          finder = {
            showExtensions = true;
            showHiddenFiles = true;
            showPathBar = true;
            showStatusBar = true;
            defaultView = "Nlsv";
          };
          trackpad = {
            tapToClick = true;
            naturalScrolling = true;
            threeFingerDrag = false;
            swipeNavigateWithScrolls = true;
            actuationStrength = 1;
            showAppExposeGesture = true;
            showMissionControlGesture = true;
          };
          keyboard = {
            keyRepeat = 2;
            initialKeyRepeat = 15;
            disablePressAndHold = true;
          };
          screencapture = {
            format = "png";
            location = "~/Screenshots";
            disableShadow = true;
          };
          global = {
            darkMode = true;
            autoSwitchTheme = true;
          };
        };

        firewall.enable = lib.mkDefault true;

        power = {
          enable = true;
          displaySleep = 15;
          computerSleep = "never";
          harddiskSleep = "never";
        };

        fonts = {
          enable = true;
          packages = with pkgs; [
            monaspace
            nerd-fonts.monaspace
            nerd-fonts.symbols-only
          ];
        };
      };

      documentation.doc.enable = false;
      nix.enable = false;
      system.tools.darwin-uninstaller.enable = false;
      system.stateVersion = 5;
    };
}
