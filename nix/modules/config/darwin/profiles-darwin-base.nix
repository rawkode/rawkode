{
  flake.darwinModules.profiles-darwin-base =
    { pkgs, lib, ... }:
    {
      # Common homebrew casks for all darwin machines
      homebrew = {
        enable = lib.mkDefault true;
        casks = [
          "alt-tab"
          "betterdisplay"
          "deskflow"
          "fantastical"
          "ghostty"
          "bartender"
        ];
        taps = [ "deskflow/tap" ];
      };

      # Shell configuration
      programs.zsh.enable = true;
      environment.shells = [
        pkgs.zsh
        pkgs.bashInteractive
      ];

      security.pam.services.sudo_local.touchIdAuth = true;

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
            threeFingerDrag = true;
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
          };
        };

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

      nix.enable = false; # Determinate packages supplies Nix daemon

      users.users.rawkode = {
        name = "rawkode";
        home = "/Users/rawkode";
      };

      system.primaryUser = "rawkode";
      system.stateVersion = 5;
    };
}
