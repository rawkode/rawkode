{ inputs, lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "dux";
  linux.home =
    { pkgs, ... }:
    {
      imports = [
        inputs.dux.homeModules.dank-material-shell
        inputs.dux.homeModules.niri
      ];

      stylix.targets.dank-material-shell.enable = true;

      programs.dank-material-shell = {
        enable = true;
        enableCalendarEvents = false;
        # Rockhopper owns clipboard history (Mod+V); stop Dux tracking it too.
        clipboardSettings.disabled = true;
        # Dux loads a plugin only when plugin_settings.json marks it enabled.
        managePluginSettings = true;
        # Phone Connect bar widget; talks to the Valent daemon enabled in desktop-common.
        plugins.dankKDEConnect.src = "${
          pkgs.fetchFromGitHub {
            owner = "duxlabs-dev";
            repo = "dux-plugins";
            rev = "b827c2296cd45a73bf9318f16a261c9edeec8339";
            hash = "sha256-OYCjryGkZ9DlMSS0DlaKzA/qRxXI+cAbO3uee+9Y+Kg=";
          }
        }/DankKDEConnect";
        # Icon-only replacement for the built-in focusedWindow widget.
        plugins.focusedAppIcon.src = ./focused-app-icon;
        niri = {
          enableKeybinds = true;
          includes.enable = false;
        };
        settings = {
          acLockTimeout = 600;
          batteryLockTimeout = 600;
          acMonitorTimeout = 1800;
          batteryMonitorTimeout = 1800;
          lockBeforeSuspend = true;
          # Sleep when left idle on battery; stay awake on AC.
          batterySuspendTimeout = 1200;
          # 0 = Suspend; machines with working hibernation can opt into 2 = SuspendThenHibernate.
          batterySuspendBehavior = lib.mkDefault 0;

          barElevationEnabled = false;
          systemTrayIconTintMode = "primary";
          # Dux fills omitted bar fields with its defaults.
          barConfigs = [
            {
              id = "default";
              name = "Main Bar";
              enabled = true;
              position = 0;
              screenPreferences = [ "all" ];
              showOnLastDisplay = true;
              leftWidgets = [
                "workspaceSwitcher"
                "focusedAppIcon"
              ];
              centerWidgets = [
                "music"
                "clock"
                "weather"
              ];
              rightWidgets = [
                {
                  id = "systemTray";
                  enabled = true;
                  trayIconSpacing = 6;
                  trayAutoOverflow = false;
                  trayUseInlineExpansion = true;
                }
                "dankKDEConnect"
                "battery"
                "controlCenterButton"
                "notificationButton"
              ];
              # Float the bar off the screen edge with roomier pills.
              spacing = 6;
              innerPadding = 6;
              widgetPadding = 10;
              iconScale = 1.1;
              transparency = 0.64;
              widgetTransparency = 0.64;
            }
          ];
        };
        systemd = {
          enable = true;
          target = "graphical-session.target";
        };
      };

      # niri-session imports the compositor environment before starting this target.
      systemd.user.services.dms.Unit.ConditionEnvironment = [
        "XDG_CURRENT_DESKTOP=niri"
        "WAYLAND_DISPLAY"
        "NIRI_SOCKET"
      ];

    };
}
