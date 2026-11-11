{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;

  umbrielCache = {
    extra-substituters = [ "https://umbriel.cachix.org" ];
    extra-trusted-public-keys = [
      "umbriel.cachix.org-1:JfNq/2yg2S6D6z4Z2dVSZrZlDPQTKtexB6GAVLD98nw="
    ];
  };
in
mkApp {
  name = "umbriel";

  linux.system = _: {
    imports = [ inputs.umbriel.nixosModules.default ];

    nix.settings = umbrielCache;

    # Registers the display-manager session and the screen-sharing portal.
    programs.umbriel.enable = true;
  };

  linux.home =
    { lib, pkgs, ... }:
    let
      once = action: {
        inherit action;
        repeat = false;
      };
      locked = action: {
        inherit action;
        allow_when_locked = true;
      };
      # Adaptive sync stays on wherever the display supports it. By default
      # HDR switches on only for fullscreen content carrying HDR metadata, so
      # the desktop stays in SDR. Outputs lacking either keep working and log
      # a warning.
      display = {
        vrr = "always";
        hdr = "auto";
      };
      # Umbriel has no mirrored-output mode, so mirroring is a fullscreen
      # wl-mirror window on the first HDMI output, showing either the focused
      # output or the rectangle the focused window occupies. wl-mirror captures
      # outputs only, so the window mode does not follow the window when it
      # moves. The HDMI connector is looked up at run time because its name
      # differs between machines and ports. Umbriel ignores the output a client
      # asks to go fullscreen on, so a machine that uses this also needs a
      # window rule sending wl-mirror to its HDMI output.
      mirror = pkgs.writeShellApplication {
        name = "umbriel-mirror";
        runtimeInputs = [
          pkgs.jq
          pkgs.libnotify
          pkgs.procps
          pkgs.wl-mirror
        ];
        text = ''
          fail() {
            echo "umbriel-mirror: $1" >&2
            notify-send "Screen mirror" "$1" || true
            exit 1
          }

          if [ "$#" -ne 1 ]; then
            echo "usage: umbriel-mirror <output|window|stop>" >&2
            exit 2
          fi

          if [ "$1" = stop ]; then
            pkill -x wl-mirror || true
            exit 0
          fi

          outputs=$(umbriel outputs --json)
          target=$(jq -r 'first(.[] | select(.enabled and (.name | startswith("HDMI"))) | .name) // empty' <<<"$outputs")
          [ -n "$target" ] || fail "No HDMI output is connected."

          region=()
          case "$1" in
            output)
              source=$(jq -r 'first(.[] | select(.focused) | .name) // empty' <<<"$outputs")
              [ -n "$source" ] || fail "No output is focused."
              ;;
            window)
              window=$(umbriel focused-window --json)
              source=$(jq -r '.output? // empty' <<<"$window")
              [ -n "$source" ] || fail "No window is focused."
              # A scrolling column can extend past its output, and wl-mirror
              # rejects a region outside the output, so the rectangle is
              # clipped to the visible part of the window.
              rect=$(jq -r --argjson w "$window" '
                .[] | select(.name == $w.output)
                | .position as $p | .logical_size as $s
                | ([$w.x, $p.x] | max) as $x0
                | ([$w.y, $p.y] | max) as $y0
                | ([$w.x + $w.w, $p.x + $s.width] | min) as $x1
                | ([$w.y + $w.h, $p.y + $s.height] | min) as $y1
                | select($x1 > $x0 and $y1 > $y0)
                | "\($x0),\($y0) \($x1 - $x0)x\($y1 - $y0)"
              ' <<<"$outputs")
              [ -n "$rect" ] || fail "The focused window is not visible."
              region=(--region "$rect")
              ;;
            *)
              fail "Unknown mode: $1"
              ;;
          esac

          [ "$source" != "$target" ] || fail "$target is the mirror target and cannot be mirrored."

          # Replaces any running mirror so the keys retarget it.
          pkill -x wl-mirror || true

          # The DP monitors render in a 10-bit HDR format that wl-mirror cannot
          # import as a DMA-BUF, so capture goes through shared memory, where
          # Umbriel supplies an 8-bit SDR view.
          exec wl-mirror --backend extcopy-shm --fullscreen-output "$target" "''${region[@]}" "$source"
        '';
      };
      workspaceBinds = lib.listToAttrs (
        lib.concatMap (
          n:
          let
            i = toString n;
          in
          [
            (lib.nameValuePair "Mod+${i}" "workspace-switch ${i}")
            (lib.nameValuePair "Mod+Ctrl+${i}" "column-move-to-workspace ${i}")
          ]
        ) (lib.range 1 9)
      );
    in
    {
      imports = [ inputs.umbriel.homeModules.default ];

      nix.settings = umbrielCache;

      # Home Manager's portal directory replaces the system one, so the Umbriel
      # backend has to be present in the user profile as well.
      xdg.portal = {
        extraPortals = [
          inputs.umbriel.packages.${pkgs.stdenv.hostPlatform.system}.xdg-desktop-portal-umbriel
        ];
        config.umbriel = {
          default = [
            "umbriel"
            "gtk"
          ];
          "org.freedesktop.impl.portal.Secret" = [ "gnome-keyring" ];
        };
      };

      programs.umbriel = {
        enable = true;
        # The NixOS module already installs the compositor.
        package = null;
        settings = {
          general.autostart = [ "noctalia" ];

          # A monitor-identity section replaces a matching connector section
          # rather than merging with it, so each one carries the display policy.
          output = {
            "eDP-1" = display // {
              scale = 2.0;
            };
            # The DP monitors stay in HDR so windowed HDR content is shown
            # as such and the panels never black out switching modes.
            "DP-1" = display // {
              hdr = "on";
              scale = 2.0;
              focus_at_startup = true;
            };
            "DP-2" = display // {
              hdr = "on";
              scale = 2.0;
            };
            "Samsung Electric Company LS32A70 HK2WB00305" = display // {
              scale = 1.75;
            };
          };

          input = {
            keyboard.numlock_toggle = true;
            touchpad = {
              tap = true;
              natural_scroll = true;
              click_method = "clickfinger";
            };
            mouse.natural_scroll = true;
            cursor = {
              hide_when_typing = true;
              hide_timeout_ms = 1000;
            };
          };

          # Spacing and radii stay on a power-of-two scale shared with the shell.
          appearance = {
            blur.radius = 4;
            corner_radius = 8;
          };

          layout = {
            gap = 16;
            extent_presets = [
              0.5
              0.75
              1.0
            ];
            scrolling = {
              default_extent_fraction = 0.9;
              center_focused = "always";
            };
          };

          window_rule = [
            { blur = true; }
            {
              match.app_id = "^dev.noctalia.Noctalia$";
              default_floating = true;
              default_floating_size_px = {
                width = 1020;
                height = 900;
              };
            }
            {
              match.app_id = "^dev.noctalia.UmbrielSharePicker$";
              default_floating = true;
              default_floating_size_px = {
                width = 800;
                height = 600;
              };
            }
            {
              match.app_id = "^firefox(-nightly)?$";
              default_workspace = 1;
            }
            {
              match.title = "^(Picture-in-Picture|Picture in picture)$";
              default_floating = true;
              default_maximize = false;
              default_position = {
                x = 16;
                y = 16;
                anchor = "bottom_right";
              };
            }
            {
              match.app_id = "^com.slack.Slack$";
              default_workspace = 3;
            }
            {
              match.app_id = "^code$";
              default_workspace = 2;
            }
            {
              match.app_id = "^1Password$";
              block_capture = true;
            }
            {
              match.title = "[Gg]mail";
              block_capture = true;
            }
          ];

          layer_rule = [
            {
              match.namespace = "^noctalia-(bar-[^\"]+|notification|dock|panel|attached-panel|osd|desktop-widget-[^\"]*)$";
              blur = true;
              blur_ignore_alpha = 0.5;
              blur_popups = true;
            }
            {
              # These open over windows, so they blur live content rather than
              # the cached wallpaper blur.
              match.namespace = "^noctalia-(notification|dock|panel|attached-panel|osd)$";
              blur_optimized = false;
            }
          ];

          # Defining this table replaces Umbriel's built-in bind set.
          keybinds = workspaceBinds // {
            "Mod+Return" = once "spawn cuetty";
            "Mod+Backslash" = once "spawn 1password --quick-access";
            "Mod+Q" = once "window-close";
            "Alt+F4" = once "window-close";
            "Mod+Escape" = "session-quit";
            "Mod+Shift+Escape" = {
              action = "shortcuts-inhibit-toggle";
              allow_when_inhibited = true;
              repeat = false;
            };
            "Mod+Shift+Slash" = once "cheatsheet-toggle";

            # Routed through the shell so its OSDs show.
            "XF86AudioRaiseVolume" = locked "spawn noctalia msg volume-up";
            "XF86AudioLowerVolume" = locked "spawn noctalia msg volume-down";
            "XF86AudioMute" = locked "spawn noctalia msg volume-mute";
            "XF86AudioPlay" = locked "spawn noctalia msg media toggle";
            "XF86AudioNext" = locked "spawn noctalia msg media next";
            "XF86AudioPrev" = locked "spawn noctalia msg media previous";
            "XF86MonBrightnessUp" = locked "spawn noctalia msg brightness-up";
            "XF86MonBrightnessDown" = locked "spawn noctalia msg brightness-down";

            # Mod+arrows: Left/Right focus columns, Up/Down switch workspaces;
            # add Shift to move the column instead.
            "Mod+Left" = "window-focus-left";
            "Mod+Right" = "window-focus-right";
            "Mod+Up" = "workspace-previous";
            "Mod+Down" = "workspace-next";
            "Mod+Shift+Left" = "column-move-left";
            "Mod+Shift+Right" = "column-move-right";
            "Mod+Shift+Up" = "column-move-to-workspace-previous";
            "Mod+Shift+Down" = "column-move-to-workspace-next";
            "Mod+H" = "window-focus-left";
            "Mod+J" = "window-focus-down";
            "Mod+K" = "window-focus-up";
            "Mod+L" = "window-focus-right";
            "Mod+Ctrl+H" = "column-move-left";
            "Mod+Ctrl+J" = "window-move-down";
            "Mod+Ctrl+K" = "window-move-up";
            "Mod+Ctrl+L" = "column-move-right";
            "Mod+Shift+H" = "output-focus-left";
            "Mod+Shift+J" = "output-focus-down";
            "Mod+Shift+K" = "output-focus-up";
            "Mod+Shift+L" = "output-focus-right";
            "Mod+Home" = "column-focus-first";
            "Mod+End" = "column-focus-last";
            "Mod+Page_Up" = "output-focus-previous";
            "Mod+Page_Down" = "output-focus-next";
            "Mod+Shift+Page_Up" = "window-move-to-output-previous";
            "Mod+Shift+Page_Down" = "window-move-to-output-next";
            "Mod+I" = "workspace-previous";
            "Mod+U" = "workspace-next";
            "Mod+Ctrl+I" = "column-move-to-workspace-previous";
            "Mod+Ctrl+U" = "column-move-to-workspace-next";

            "Mod+O" = once "overview-toggle";
            "Ctrl+Up" = once "overview-open";
            "Mod+Comma" = "window-consume-left";
            "Mod+Period" = "window-consume-right";
            "Mod+R" = "window-cycle-primary-extent";
            "Mod+Shift+R" = "window-cycle-primary-extent-back";
            "Mod+Ctrl+Shift+R" = "window-cycle-secondary-extent";
            "Mod+F" = once "window-toggle-maximize";
            "Mod+Shift+F" = once "window-toggle-fullscreen";
            "Mod+Ctrl+C" = "column-center";
            "Mod+Shift+V" = once "window-toggle-floating";
            "Mod+Ctrl+Space" = once "window-focus-switch-floating";
            "Mod+Shift+T" = once "column-toggle-tabbed";

            # Mod+{ and Mod+}. The override applies to the focused workspace
            # and lasts until the next config reload.
            "Mod+Shift+BracketLeft" = once "workspace-set-layout scrolling";
            "Mod+Shift+BracketRight" = once "workspace-set-layout master";

            # Retarget an active screencast without re-sharing.
            "Mod+S" = once "screencast-set-window";
            "Mod+Shift+S" = once "screencast-set-output";
            "Mod+Ctrl+S" = once "screencast-clear";
            "Mod+Shift+P" = once "dpms-off";
            # Mirror the focused window or output to the HDMI monitor.
            "Mod+Print" = once "spawn ${lib.getExe mirror} window";
            "Mod+Shift+Print" = once "spawn ${lib.getExe mirror} output";
            "Mod+Ctrl+Print" = once "spawn ${lib.getExe mirror} stop";
          };
        };
      };
    };
}
