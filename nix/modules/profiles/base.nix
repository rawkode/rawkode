{
  flake.nixosModules.profiles-base =
    {
      inputs,
      lib,
      pkgs,
      ...
    }:
    {
      imports = [
        inputs.disko.nixosModules.disko
        inputs.flatpaks.nixosModules.nix-flatpak
        inputs.home-manager.nixosModules.home-manager
        inputs.lanzaboote.nixosModules.lanzaboote
        inputs.niri.nixosModules.niri
        inputs.nix-index-database.nixosModules.nix-index
        inputs.nur.modules.nixos.default

        inputs.self.nixosModules.below
        inputs.self.nixosModules.common
        inputs.self.nixosModules.containers
        inputs.self.nixosModules.fish
        inputs.self.nixosModules.greetd
        inputs.self.nixosModules.lanzaboote
        inputs.self.nixosModules.networking
        inputs.self.nixosModules.nix
        inputs.self.nixosModules.stylix
        inputs.self.nixosModules.sudo
        inputs.self.nixosModules.systemd
        inputs.self.nixosModules.tailscale
        inputs.self.nixosModules.tpm2
        inputs.self.nixosModules.user
      ];

      environment.systemPackages = with pkgs; [
        curl
        git
        htop
        nodejs
        vim
        wget
      ];

      boot.loader.efi = {
        canTouchEfiVariables = lib.mkDefault true;
        efiSysMountPoint = lib.mkDefault "/boot";
      };

      nixpkgs.config = {
        allowUnfree = true;
        joypixels.acceptLicense = true;
      };

      nix = {
        settings = {
          experimental-features = [
            "nix-command"
            "flakes"
          ];
          auto-optimise-store = true;
        };
        gc = {
          automatic = lib.mkDefault true;
          dates = "weekly";
          options = "--delete-older-than 30d";
        };
        registry = {
          nixpkgs.flake = inputs.nixpkgs;
          rawkode.flake = inputs.self;
          templates.flake = inputs.self;
        };
      };

      system.stateVersion = "25.11";
    };

  flake.darwinModules.profiles-base =
    {
      inputs,
      config,
      lib,
      pkgs,
      ...
    }:
    let
      firewallCfg = config.rawkOS.darwin.firewall;
      systemDefaultsCfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      imports = [
        inputs.self.darwinModules.alt-tab
        inputs.self.darwinModules.fantastical
        inputs.self.darwinModules.fonts
        inputs.self.darwinModules.ghostty
        inputs.self.darwinModules.kree
        inputs.self.darwinModules.mimestream
        inputs.self.darwinModules.power
        inputs.self.darwinModules.zed
      ];

      options.rawkOS.darwin.firewall = {
        enable = lib.mkEnableOption "macOS application firewall";

        stealthMode = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable stealth mode (don't respond to ICMP ping requests or connection attempts)";
        };

        blockAllIncoming = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Block all incoming connections except those required for basic internet services";
        };

        allowSigned = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Allow built-in signed applications to receive incoming connections automatically";
        };

        allowSignedApp = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Allow downloaded signed applications to receive incoming connections automatically";
        };

        logging = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Enable firewall logging";
        };
      };

      options.rawkOS.darwin.systemDefaults = {
        enable = lib.mkEnableOption "macOS system defaults configuration";

        dock = {
          autohide = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Automatically hide the dock";
          };

          autohideDelay = lib.mkOption {
            type = lib.types.float;
            default = 0.0;
            description = "Delay before dock auto-hides (seconds)";
          };

          autohideTimeModifier = lib.mkOption {
            type = lib.types.float;
            default = 0.15;
            description = "Speed of dock hide/show animation";
          };

          orientation = lib.mkOption {
            type = lib.types.enum [
              "bottom"
              "left"
              "right"
            ];
            default = "right";
            description = "Dock position on screen";
          };

          tilesize = lib.mkOption {
            type = lib.types.int;
            default = 44;
            description = "Dock icon size in pixels";
          };

          launchanim = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Animate opening applications";
          };

          minimizeToApplication = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Minimize windows into application icon";
          };

          showProcessIndicators = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Show indicator lights for open applications";
          };

          showRecents = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Show recent applications in dock";
          };

          persistentApps = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = "List of persistent dock applications (paths)";
          };

          exposeAnimationDuration = lib.mkOption {
            type = lib.types.float;
            default = 0.2;
            description = "Mission Control animation duration";
          };

          exposeGroupApps = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Group windows by application in Mission Control";
          };

          mruSpaces = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Automatically rearrange Spaces based on most recent use";
          };

          appswitcherAllDisplays = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Show app switcher on all displays";
          };

          # Hot corners (1 = disabled, 2 = mission control, 3 = application windows,
          # 4 = desktop, 5 = start screen saver, 6 = disable screen saver,
          # 10 = put display to sleep, 11 = launchpad, 12 = notification center)
          hotCornerTopLeft = lib.mkOption {
            type = lib.types.int;
            default = 1;
            description = "Hot corner action for top-left";
          };

          hotCornerTopRight = lib.mkOption {
            type = lib.types.int;
            default = 12;
            description = "Hot corner action for top-right (12 = notification center)";
          };

          hotCornerBottomLeft = lib.mkOption {
            type = lib.types.int;
            default = 1;
            description = "Hot corner action for bottom-left";
          };

          hotCornerBottomRight = lib.mkOption {
            type = lib.types.int;
            default = 4;
            description = "Hot corner action for bottom-right (4 = desktop)";
          };
        };

        finder = {
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
            description = "Show path bar at bottom of Finder windows";
          };

          showStatusBar = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Show status bar at bottom of Finder windows";
          };

          showPosixPath = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Show full POSIX path in Finder title bar";
          };

          defaultView = lib.mkOption {
            type = lib.types.enum [
              "icnv"
              "Nlsv"
              "clmv"
              "Flwv"
            ];
            default = "Nlsv";
            description = "Default Finder view (icnv=Icon, Nlsv=List, clmv=Column, Flwv=Gallery)";
          };

          quitMenuItem = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Allow quitting Finder via Cmd+Q";
          };
        };

        trackpad = {
          tapToClick = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable tap to click";
          };

          naturalScrolling = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable natural scrolling direction";
          };

          threeFingerDrag = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable three-finger drag";
          };

          rightClick = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable two-finger right click";
          };
        };

        keyboard = {
          keyRepeat = lib.mkOption {
            type = lib.types.int;
            default = 2;
            description = "Key repeat rate (lower = faster, 1-15)";
          };

          initialKeyRepeat = lib.mkOption {
            type = lib.types.int;
            default = 15;
            description = "Delay before key repeat starts (lower = faster, 10-120)";
          };

          disablePressAndHold = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Disable press-and-hold for character accents (enables key repeat)";
          };

          fnUsageType = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Function key behavior (null = default)";
          };
        };

        screencapture = {
          format = lib.mkOption {
            type = lib.types.enum [
              "png"
              "jpg"
              "pdf"
              "tiff"
              "gif"
              "bmp"
            ];
            default = "png";
            description = "Screenshot file format";
          };

          location = lib.mkOption {
            type = lib.types.str;
            default = "~/Screenshots";
            description = "Screenshot save location";
          };

          disableShadow = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Disable shadow in window screenshots";
          };

          includeDate = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Include date in screenshot filename";
          };
        };

        global = {
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
            description = "Reduce motion in UI animations";
          };
        };
      };

      config = lib.mkMerge [
        {
          # Common apps for all darwin machines
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

            firewall = {
              enable = lib.mkDefault true;
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

          # User configuration is handled by the users-* module from mkUser
          # which sets users.users.${username} and system.primaryUser

          system.stateVersion = 5;
        }
        (lib.mkIf firewallCfg.enable {
          networking.applicationFirewall = {
            enable = true;
            enableStealthMode = firewallCfg.stealthMode;
            inherit (firewallCfg) blockAllIncoming;
            inherit (firewallCfg) allowSigned;
            inherit (firewallCfg) allowSignedApp;
          };
        })
        (lib.mkIf systemDefaultsCfg.enable {
          system.defaults = {
            dock = {
              inherit (systemDefaultsCfg.dock) autohide;
              autohide-delay = systemDefaultsCfg.dock.autohideDelay;
              autohide-time-modifier = systemDefaultsCfg.dock.autohideTimeModifier;
              inherit (systemDefaultsCfg.dock) orientation;
              inherit (systemDefaultsCfg.dock) tilesize;
              inherit (systemDefaultsCfg.dock) launchanim;
              minimize-to-application = systemDefaultsCfg.dock.minimizeToApplication;
              show-process-indicators = systemDefaultsCfg.dock.showProcessIndicators;
              show-recents = systemDefaultsCfg.dock.showRecents;
              persistent-apps = systemDefaultsCfg.dock.persistentApps;
              expose-animation-duration = systemDefaultsCfg.dock.exposeAnimationDuration;
              expose-group-apps = systemDefaultsCfg.dock.exposeGroupApps;
              mru-spaces = systemDefaultsCfg.dock.mruSpaces;
              appswitcher-all-displays = systemDefaultsCfg.dock.appswitcherAllDisplays;
              wvous-tl-corner = systemDefaultsCfg.dock.hotCornerTopLeft;
              wvous-tr-corner = systemDefaultsCfg.dock.hotCornerTopRight;
              wvous-bl-corner = systemDefaultsCfg.dock.hotCornerBottomLeft;
              wvous-br-corner = systemDefaultsCfg.dock.hotCornerBottomRight;
            };

            finder = {
              AppleShowAllExtensions = systemDefaultsCfg.finder.showExtensions;
              AppleShowAllFiles = systemDefaultsCfg.finder.showHiddenFiles;
              ShowPathbar = systemDefaultsCfg.finder.showPathBar;
              ShowStatusBar = systemDefaultsCfg.finder.showStatusBar;
              _FXShowPosixPathInTitle = systemDefaultsCfg.finder.showPosixPath;
              FXPreferredViewStyle = systemDefaultsCfg.finder.defaultView;
              QuitMenuItem = systemDefaultsCfg.finder.quitMenuItem;
            };

            trackpad = {
              Clicking = systemDefaultsCfg.trackpad.tapToClick;
              TrackpadRightClick = systemDefaultsCfg.trackpad.rightClick;
              TrackpadThreeFingerDrag = systemDefaultsCfg.trackpad.threeFingerDrag;
            };

            NSGlobalDomain = {
              "com.apple.swipescrolldirection" = systemDefaultsCfg.trackpad.naturalScrolling;
              KeyRepeat = systemDefaultsCfg.keyboard.keyRepeat;
              InitialKeyRepeat = systemDefaultsCfg.keyboard.initialKeyRepeat;
              ApplePressAndHoldEnabled = !systemDefaultsCfg.keyboard.disablePressAndHold;
              AppleInterfaceStyle = if systemDefaultsCfg.global.darkMode then "Dark" else null;
              AppleInterfaceStyleSwitchesAutomatically = systemDefaultsCfg.global.autoSwitchTheme;
              AppleShowAllExtensions = systemDefaultsCfg.finder.showExtensions;
              AppleShowAllFiles = systemDefaultsCfg.finder.showHiddenFiles;
              NSAutomaticWindowAnimationsEnabled = !systemDefaultsCfg.global.reduceMotion;
            };

            screencapture = {
              type = systemDefaultsCfg.screencapture.format;
              inherit (systemDefaultsCfg.screencapture) location;
              disable-shadow = systemDefaultsCfg.screencapture.disableShadow;
              include-date = systemDefaultsCfg.screencapture.includeDate;
            };
          };
        })
      ];
    };
}
