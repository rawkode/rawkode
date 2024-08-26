# Generated via dconf2nix: https://github.com/gvolpe/dconf2nix
{ lib, ... }:

with lib.hm.gvariant;

{
  dconf.settings = {
    "apps/seahorse/listing" = {
      keyrings-selected = [ "secret-service:///org/freedesktop/secrets/collection/login" ];
    };

    "apps/seahorse/windows/key-manager" = {
      height = 1324;
      width = 1244;
    };

    "ca/desrt/dconf-editor" = {
      saved-pathbar-path = "/org/gnome/shell/extensions/space-bar/appearance/";
      saved-view = "/org/gnome/shell/extensions/space-bar/";
      show-warning = false;
      window-height = 1325;
      window-is-maximized = false;
      window-width = 2530;
    };

    "com/mattjakeman/ExtensionManager" = {
      height = 1252;
      is-maximized = false;
      last-used-version = "0.5.1";
      width = 2530;
    };

    "com/saivert/pwvucontrol" = {
      is-maximized = true;
      window-height = 640;
      window-width = 820;
    };

    "io/github/kaii_lb/Overskride" = {
      current-adapter-name = "hci0";
      first-auto-accept = true;
      original-adapter-name = "hci0";
      store-folder = "/home/rawkode/Downloads";
      window-height = 1346;
      window-maximized = true;
      window-width = 2520;
    };

    "org/blueman/general" = {
      window-properties = [ 1267 1444 0 0 ];
    };

    "org/erikreider/swaync" = {
      dnd-state = false;
    };

    "org/gnome/Console" = {
      custom-font = "DejaVu Sans Mono 16";
      last-window-maximised = false;
      last-window-size = mkTuple [ 2530 1408 ];
      use-system-font = false;
    };

    "org/gnome/Extensions" = {
      window-height = 1408;
      window-maximized = true;
      window-width = 2528;
    };

    "org/gnome/Snapshot" = {
      is-maximized = false;
      window-height = 640;
      window-width = 2560;
    };

    "org/gnome/Totem" = {
      active-plugins = [ "vimeo" "variable-rate" "skipto" "screenshot" "screensaver" "save-file" "rotation" "recent" "movie-properties" "open-directory" "mpris" "autoload-subtitles" "apple-trailers" ];
      subtitle-encoding = "UTF-8";
    };

    "org/gnome/calculator" = {
      accuracy = 9;
      angle-units = "degrees";
      base = 10;
      button-mode = "basic";
      number-format = "automatic";
      show-thousands = false;
      show-zeroes = false;
      source-currency = "";
      source-units = "degree";
      target-currency = "";
      target-units = "radian";
      window-maximized = true;
      window-size = mkTuple [ 360 495 ];
      word-size = 64;
    };

    "org/gnome/cheese" = {
      burst-delay = 1000;
      camera = "ILCE-7CM2 (V4L2)";
      photo-x-resolution = 3840;
      photo-y-resolution = 2160;
      video-x-resolution = 3840;
      video-y-resolution = 2160;
    };

    "org/gnome/clocks" = {
      world-clocks = [ {
        location = mkVariant [ (mkUint32 2) (mkVariant [ "Chicago" "KMDW" true [ (mkTuple [ 0.7292712893531614 (-1.5316185371029443) ]) ] [ (mkTuple [ 0.7304208679182801 (-1.529781996944241) ]) ] ]) ];
      } {
        location = mkVariant [ (mkUint32 2) (mkVariant [ "San Francisco" "KOAK" true [ (mkTuple [ 0.6583284898216201 (-2.133408063190589) ]) ] [ (mkTuple [ 0.659296885757089 (-2.136621860115334) ]) ] ]) ];
      } ];
    };

    "org/gnome/clocks/state/window" = {
      maximized = true;
      panel-id = "world";
      size = mkTuple [ 1256 1388 ];
    };

    "org/gnome/control-center" = {
      last-panel = "system";
      window-state = mkTuple [ 2530 1376 true ];
    };

    "org/gnome/desktop/a11y/applications" = {
      screen-reader-enabled = false;
    };

    "org/gnome/desktop/app-folders" = {
      folder-children = [ "Utilities" "YaST" "Pardus" ];
    };

    "org/gnome/desktop/app-folders/folders/Pardus" = {
      categories = [ "X-Pardus-Apps" ];
      name = "X-Pardus-Apps.directory";
      translate = true;
    };

    "org/gnome/desktop/app-folders/folders/Utilities" = {
      apps = [ "gnome-abrt.desktop" "gnome-system-log.desktop" "nm-connection-editor.desktop" "org.gnome.baobab.desktop" "org.gnome.Connections.desktop" "org.gnome.DejaDup.desktop" "org.gnome.Dictionary.desktop" "org.gnome.DiskUtility.desktop" "org.gnome.Evince.desktop" "org.gnome.FileRoller.desktop" "org.gnome.fonts.desktop" "org.gnome.Loupe.desktop" "org.gnome.seahorse.Application.desktop" "org.gnome.tweaks.desktop" "org.gnome.Usage.desktop" "vinagre.desktop" ];
      categories = [ "X-GNOME-Utilities" ];
      name = "X-GNOME-Utilities.directory";
      translate = true;
    };

    "org/gnome/desktop/app-folders/folders/YaST" = {
      categories = [ "X-SuSE-YaST" ];
      name = "suse-yast.directory";
      translate = true;
    };

    "org/gnome/desktop/background" = {
      color-shading-type = "solid";
      picture-options = "zoom";
      picture-uri = "file:///home/rawkode/.local/share/backgrounds/2024-07-22-11-27-45-Gradient%20Logo%20Black.jpg";
      picture-uri-dark = "file:///home/rawkode/.local/share/backgrounds/2024-07-22-11-27-45-Gradient%20Logo%20Black.jpg";
      primary-color = "#000000000000";
      secondary-color = "#000000000000";
    };

    "org/gnome/desktop/datetime" = {
      automatic-timezone = true;
    };

    "org/gnome/desktop/input-sources" = {
      sources = [ (mkTuple [ "xkb" "us" ]) ];
      xkb-options = [ "terminate:ctrl_alt_bksp" ];
    };

    "org/gnome/desktop/interface" = {
      clock-show-date = false;
      color-scheme = "prefer-dark";
      cursor-size = 24;
      cursor-theme = "catppuccin-mocha-mauve-cursors";
      enable-animations = true;
      font-name = "Monaspace Argon,  12";
      gtk-theme = "";
      icon-theme = "catppuccin-mocha-mauve-cursors";
      scaling-factor = mkUint32 1;
      text-scaling-factor = 1.0;
      toolbar-style = "text";
    };

    "org/gnome/desktop/notifications" = {
      application-children = [ "gnome-power-panel" "org-gnome-console" "r-quick-share" "vivaldi-stable" "discord" "org-gnome-characters" "slack" "firefox-nightly" "vesktop" "org-gnome-software" ];
    };

    "org/gnome/desktop/notifications/application/discord" = {
      application-id = "discord.desktop";
    };

    "org/gnome/desktop/notifications/application/firefox-nightly" = {
      application-id = "firefox-nightly.desktop";
    };

    "org/gnome/desktop/notifications/application/gnome-power-panel" = {
      application-id = "gnome-power-panel.desktop";
    };

    "org/gnome/desktop/notifications/application/org-gnome-characters" = {
      application-id = "org.gnome.Characters.desktop";
    };

    "org/gnome/desktop/notifications/application/org-gnome-console" = {
      application-id = "org.gnome.Console.desktop";
    };

    "org/gnome/desktop/notifications/application/org-gnome-software" = {
      application-id = "org.gnome.Software.desktop";
    };

    "org/gnome/desktop/notifications/application/r-quick-share" = {
      application-id = "r-quick-share.desktop";
    };

    "org/gnome/desktop/notifications/application/slack" = {
      application-id = "slack.desktop";
    };

    "org/gnome/desktop/notifications/application/vesktop" = {
      application-id = "vesktop.desktop";
    };

    "org/gnome/desktop/notifications/application/vivaldi-stable" = {
      application-id = "vivaldi-stable.desktop";
    };

    "org/gnome/desktop/peripherals/keyboard" = {
      numlock-state = true;
    };

    "org/gnome/desktop/peripherals/mouse" = {
      natural-scroll = true;
    };

    "org/gnome/desktop/peripherals/touchpad" = {
      disable-while-typing = true;
      two-finger-scrolling-enabled = true;
    };

    "org/gnome/desktop/privacy" = {
      report-technical-problems = false;
    };

    "org/gnome/desktop/screensaver" = {
      color-shading-type = "solid";
      picture-options = "zoom";
      picture-uri = "file:///home/rawkode/.local/share/backgrounds/2024-07-22-11-27-45-Gradient%20Logo%20Black.jpg";
      primary-color = "#000000000000";
      secondary-color = "#000000000000";
    };

    "org/gnome/desktop/search-providers" = {
      disabled = [ "org.gnome.Boxes.desktop" ];
      enabled = [ "org.gnome.Weather.desktop" ];
      sort-order = [ "org.gnome.Boxes.desktop" "org.gnome.Calculator.desktop" "org.gnome.Calendar.desktop" "org.gnome.clocks.desktop" "org.gnome.Contacts.desktop" "org.gnome.design.IconLibrary.desktop" "org.gnome.Documents.desktop" "org.gnome.Nautilus.desktop" "org.gnome.seahorse.Application.desktop" "org.gnome.Settings.desktop" "org.gnome.Software.desktop" "org.gnome.Weather.desktop" ];
    };

    "org/gnome/desktop/sound" = {
      event-sounds = true;
      theme-name = "ocean";
    };

    "org/gnome/desktop/wm/keybindings" = {
      close = [];
      maximize = [];
      move-to-monitor-down = [];
      move-to-monitor-left = [];
      move-to-monitor-right = [];
      move-to-monitor-up = [];
      move-to-workspace-1 = [ "<super><shift>1" ];
      move-to-workspace-10 = [ "<Super><Shift>0" ];
      move-to-workspace-2 = [ "<super><shift>2" ];
      move-to-workspace-3 = [ "<super><shift>3" ];
      move-to-workspace-4 = [ "<super><shift>4" ];
      move-to-workspace-5 = [ "<super><shift>5" ];
      move-to-workspace-6 = [ "<Super><Shift>6" ];
      move-to-workspace-7 = [ "<Super><Shift>7" ];
      move-to-workspace-8 = [ "<Super><Shift>8" ];
      move-to-workspace-9 = [ "<Super><Shift>9" ];
      move-to-workspace-down = [ "<Control><Shift><Alt>Down" ];
      move-to-workspace-left = [];
      move-to-workspace-right = [];
      move-to-workspace-up = [ "<Control><Shift><Alt>Up" ];
      switch-applications = [ "<Super>Tab" "<Alt>Tab" ];
      switch-applications-backward = [ "<Shift><Super>Tab" "<Shift><Alt>Tab" ];
      switch-group = [ "<Super>Above_Tab" "<Alt>Above_Tab" ];
      switch-group-backward = [ "<Shift><Super>Above_Tab" "<Shift><Alt>Above_Tab" ];
      switch-input-source = [];
      switch-panels = [ "<Control><Alt>Tab" ];
      switch-panels-backward = [ "<Shift><Control><Alt>Tab" ];
      switch-to-workspace-1 = [ "<super>1" ];
      switch-to-workspace-2 = [ "<super>2" ];
      switch-to-workspace-3 = [ "<super>3" ];
      switch-to-workspace-4 = [ "<super>4" ];
      switch-to-workspace-5 = [ "<super>5" ];
      switch-to-workspace-last = [];
      switch-to-workspace-left = [];
      switch-to-workspace-right = [];
      toggle-maximized = [ "<super>Return" ];
      unmaximize = [];
    };

    "org/gnome/desktop/wm/preferences" = {
      button-layout = ":close";
      focus-mode = "click";
    };

    "org/gnome/epiphany" = {
      ask-for-default = false;
    };

    "org/gnome/epiphany/state" = {
      is-maximized = true;
      window-size = mkTuple [ 2560 1411 ];
    };

    "org/gnome/evolution-data-server" = {
      migrated = true;
    };

    "org/gnome/file-roller/listing" = {
      list-mode = "as-folder";
      show-path = false;
      sort-method = "name";
      sort-type = "ascending";
    };

    "org/gnome/file-roller/ui" = {
      sidebar-width = 256;
      window-height = 1408;
      window-width = 1256;
    };

    "org/gnome/mutter" = {
      attach-modal-dialogs = false;
      dynamic-workspaces = true;
      edge-tiling = false;
      experimental-features = [ "scale-monitor-framebuffer" ];
      workspaces-only-on-primary = false;
    };

    "org/gnome/mutter/keybindings" = {
      cancel-input-capture = [];
      toggle-tiled-left = [];
      toggle-tiled-right = [];
    };

    "org/gnome/mutter/wayland/keybindings" = {
      restore-shortcuts = [ "<Super>Escape" ];
    };

    "org/gnome/nautilus/preferences" = {
      default-folder-viewer = "list-view";
      migrated-gtk-settings = true;
      search-filter-time-type = "last_modified";
    };

    "org/gnome/nautilus/window-state" = {
      initial-size = mkTuple [ 2530 1328 ];
      maximized = false;
    };

    "org/gnome/portal/filechooser/discord" = {
      last-folder-path = "/home/rawkode/Downloads";
    };

    "org/gnome/portal/filechooser/vivaldi-stable" = {
      last-folder-path = "/home/rawkode/Downloads";
    };

    "org/gnome/settings-daemon/plugins/media-keys" = {
      rotate-video-lock-static = [];
    };

    "org/gnome/settings-daemon/plugins/power" = {
      power-button-action = "interactive";
      sleep-inactive-ac-type = "nothing";
    };

    "org/gnome/shell" = {
      disable-user-extensions = false;
      disabled-extensions = [ "sound-output-device-chooser@kgshank.net" "material-shell@papyelgringo" "gnome-one-window-wonderland@jqno.nl" "windowsNavigator@gnome-shell-extensions.gcampax.github.com" ];
      enabled-extensions = [ "appindicatorsupport@rgcjonas.gmail.com" "auto-move-windows@gnome-shell-extensions.gcampax.github.com" "emoji-copy@felipeftn" "gsconnect@andyholmes.github.io" "just-perfection-desktop@just-perfection" "nightthemeswitcher@romainvigier.fr" "rclone-manager@germanztz.com" "sound-output-device-chooser@kgshank.net" "space-bar@luchrioh" "tailscale@joaophi.github.com" "user-theme@gnome-shell-extensions.gcampax.github.com" "vertical-workspaces@G-dH.github.com" "paperwm@paperwm.github.com" ];
      favorite-apps = [];
      last-selected-power-profile = "performance";
      welcome-dialog-last-shown-version = "42.0";
    };

    "org/gnome/shell/app-switcher" = {
      current-workspace-only = true;
    };

    "org/gnome/shell/extensions/auto-move-windows" = {
      application-list = [ "vivaldi-stable.desktop:1" "org.wezfurlong.wezterm.desktop:2" "code.desktop:2" "vesktop.desktop:3" "slack.desktop:3" "spotify.desktop:4" ];
    };

    "org/gnome/shell/extensions/blur-my-shell" = {
      hacks-level = 0;
      settings-version = 2;
    };

    "org/gnome/shell/extensions/blur-my-shell/appfolder" = {
      brightness = 0.6;
      sigma = 30;
    };

    "org/gnome/shell/extensions/blur-my-shell/applications" = {
      blur = false;
      brightness = 0.32;
      enable-all = true;
      opacity = 201;
      sigma = 64;
    };

    "org/gnome/shell/extensions/blur-my-shell/dash-to-dock" = {
      blur = false;
      brightness = 0.6;
      pipeline = "pipeline_default_rounded";
      sigma = 30;
      static-blur = true;
      style-dash-to-dock = 0;
    };

    "org/gnome/shell/extensions/blur-my-shell/lockscreen" = {
      pipeline = "pipeline_default";
    };

    "org/gnome/shell/extensions/blur-my-shell/overview" = {
      pipeline = "pipeline_default";
      style-components = 0;
    };

    "org/gnome/shell/extensions/blur-my-shell/panel" = {
      brightness = 0.6;
      force-light-text = false;
      pipeline = "pipeline_default";
      sigma = 100;
      static-blur = false;
    };

    "org/gnome/shell/extensions/blur-my-shell/screenshot" = {
      pipeline = "pipeline_default";
    };

    "org/gnome/shell/extensions/blur-my-shell/window-list" = {
      brightness = 0.6;
      sigma = 30;
    };

    "org/gnome/shell/extensions/com/github/hermes83/compiz-windows-effect" = {
      resize-effect = true;
    };

    "org/gnome/shell/extensions/coverflowalttab" = {
      blur-radius = 0.0;
      easing-function = "ease-in-out-quad";
      icon-style = "Classic";
      invert-swipes = true;
      switch-application-behaves-like-switch-windows = false;
      switcher-background-color = mkTuple [ 1.0 1.0 1.0 ];
    };

    "org/gnome/shell/extensions/emoji-copy" = {
      emoji-keybind = [ "<Super>e" ];
      recently-used = [ "\128514" "\10084\65039" "\128525" "\128557" "\128522" "\128530" "\128536" "\128553" "\129300" "\9786\65039" "\128076" ];
    };

    "org/gnome/shell/extensions/forge" = {
      css-last-update = mkUint32 37;
      focus-border-toggle = false;
      tiling-mode-enabled = false;
      window-gap-hidden-on-single = false;
    };

    "org/gnome/shell/extensions/forge/keybindings" = {
      con-split-horizontal = [ "<Super>z" ];
      con-split-layout-toggle = [ "<Super>g" ];
      con-split-vertical = [ "<Super>v" ];
      con-tabbed-showtab-decoration-toggle = [ "<Control><Alt>y" ];
      focus-border-toggle = [ "<Super>x" ];
      prefs-tiling-toggle = [ "<Super>w" ];
      window-gap-size-decrease = [ "<Control><Super>minus" ];
      window-gap-size-increase = [ "<Control><Super>plus" ];
      window-resize-bottom-decrease = [ "<Shift><Control><Super>i" ];
      window-resize-bottom-increase = [ "<Control><Super>u" ];
      window-resize-left-decrease = [ "<Shift><Control><Super>o" ];
      window-resize-left-increase = [ "<Control><Super>y" ];
      window-resize-right-decrease = [ "<Shift><Control><Super>y" ];
      window-resize-right-increase = [ "<Control><Super>o" ];
      window-resize-top-decrease = [ "<Shift><Control><Super>u" ];
      window-resize-top-increase = [ "<Control><Super>i" ];
      window-snap-center = [ "<Control><Alt>c" ];
      window-snap-one-third-left = [ "<Control><Alt>d" ];
      window-snap-one-third-right = [ "<Control><Alt>g" ];
      window-snap-two-third-left = [ "<Control><Alt>e" ];
      window-snap-two-third-right = [ "<Control><Alt>t" ];
      window-swap-down = [ "<Control><Super>j" ];
      window-swap-last-active = [ "<Super>Return" ];
      window-swap-left = [ "<Control><Super>h" ];
      window-swap-right = [ "<Control><Super>l" ];
      window-swap-up = [ "<Control><Super>k" ];
      window-toggle-always-float = [ "<Shift><Super>c" ];
      workspace-active-tile-toggle = [ "<Shift><Super>w" ];
    };

    "org/gnome/shell/extensions/gsconnect" = {
      devices = [];
      id = "e3688dea-3ffc-4ae0-85da-7d4938610efd";
      name = "p4x-desktop-nixos";
    };

    "org/gnome/shell/extensions/gsconnect/device/_52b7a9b7_f71e_4915_8db4_7dba7d6ecae2_" = {
      incoming-capabilities = [ "kdeconnect.battery" "kdeconnect.battery.request" "kdeconnect.bigscreen.stt" "kdeconnect.clipboard" "kdeconnect.clipboard.connect" "kdeconnect.connectivity_report" "kdeconnect.contacts.response_uids_timestamps" "kdeconnect.contacts.response_vcards" "kdeconnect.findmyphone.request" "kdeconnect.lock" "kdeconnect.lock.request" "kdeconnect.mousepad.echo" "kdeconnect.mousepad.keyboardstate" "kdeconnect.mousepad.request" "kdeconnect.mpris" "kdeconnect.mpris.request" "kdeconnect.notification" "kdeconnect.notification.request" "kdeconnect.photo" "kdeconnect.ping" "kdeconnect.presenter" "kdeconnect.runcommand" "kdeconnect.runcommand.request" "kdeconnect.sftp" "kdeconnect.share.request" "kdeconnect.sms.attachment_file" "kdeconnect.sms.messages" "kdeconnect.systemvolume" "kdeconnect.systemvolume.request" "kdeconnect.telephony" "kdeconnect.telephony.request_mute" "kdeconnect.virtualmonitor" "kdeconnect.virtualmonitor.request" ];
      last-connection = "lan://192.168.178.20:1716";
      name = "p4x-desktop-nixos";
      outgoing-capabilities = [ "kdeconnect.battery" "kdeconnect.battery.request" "kdeconnect.bigscreen.stt" "kdeconnect.clipboard" "kdeconnect.clipboard.connect" "kdeconnect.connectivity_report.request" "kdeconnect.contacts.request_all_uids_timestamps" "kdeconnect.contacts.request_vcards_by_uid" "kdeconnect.findmyphone.request" "kdeconnect.lock" "kdeconnect.lock.request" "kdeconnect.mousepad.keyboardstate" "kdeconnect.mousepad.request" "kdeconnect.mpris" "kdeconnect.mpris.request" "kdeconnect.notification" "kdeconnect.notification.action" "kdeconnect.notification.reply" "kdeconnect.notification.request" "kdeconnect.photo.request" "kdeconnect.ping" "kdeconnect.runcommand" "kdeconnect.runcommand.request" "kdeconnect.sftp.request" "kdeconnect.share.request" "kdeconnect.share.request.update" "kdeconnect.sms.request" "kdeconnect.sms.request_attachment" "kdeconnect.sms.request_conversation" "kdeconnect.sms.request_conversations" "kdeconnect.systemvolume" "kdeconnect.systemvolume.request" "kdeconnect.telephony" "kdeconnect.telephony.request_mute" "kdeconnect.virtualmonitor" "kdeconnect.virtualmonitor.request" ];
      supported-plugins = [ "battery" "clipboard" "findmyphone" "mousepad" "mpris" "notification" "ping" "runcommand" "share" "systemvolume" "telephony" ];
      type = "desktop";
    };

    "org/gnome/shell/extensions/gsconnect/device/a8af87e3_e221_4cd5_b7c5_a2f1cbdd6fe6" = {
      incoming-capabilities = [ "kdeconnect.battery" "kdeconnect.bigscreen.stt" "kdeconnect.clipboard" "kdeconnect.clipboard.connect" "kdeconnect.contacts.request_all_uids_timestamps" "kdeconnect.contacts.request_vcards_by_uid" "kdeconnect.findmyphone.request" "kdeconnect.mousepad.keyboardstate" "kdeconnect.mousepad.request" "kdeconnect.mpris" "kdeconnect.mpris.request" "kdeconnect.notification" "kdeconnect.notification.action" "kdeconnect.notification.reply" "kdeconnect.notification.request" "kdeconnect.ping" "kdeconnect.runcommand" "kdeconnect.sftp.request" "kdeconnect.share.request" "kdeconnect.share.request.update" "kdeconnect.sms.request" "kdeconnect.sms.request_attachment" "kdeconnect.sms.request_conversation" "kdeconnect.sms.request_conversations" "kdeconnect.systemvolume" "kdeconnect.telephony.request" "kdeconnect.telephony.request_mute" ];
      last-connection = "lan://192.168.178.48:1716";
      name = "p4x-phone";
      outgoing-capabilities = [ "kdeconnect.battery" "kdeconnect.bigscreen.stt" "kdeconnect.clipboard" "kdeconnect.clipboard.connect" "kdeconnect.connectivity_report" "kdeconnect.contacts.response_uids_timestamps" "kdeconnect.contacts.response_vcards" "kdeconnect.findmyphone.request" "kdeconnect.mousepad.echo" "kdeconnect.mousepad.keyboardstate" "kdeconnect.mousepad.request" "kdeconnect.mpris" "kdeconnect.mpris.request" "kdeconnect.notification" "kdeconnect.notification.request" "kdeconnect.ping" "kdeconnect.presenter" "kdeconnect.runcommand.request" "kdeconnect.sftp" "kdeconnect.share.request" "kdeconnect.sms.attachment_file" "kdeconnect.sms.messages" "kdeconnect.systemvolume.request" "kdeconnect.telephony" ];
      supported-plugins = [ "battery" "clipboard" "connectivity_report" "contacts" "findmyphone" "mousepad" "mpris" "notification" "ping" "presenter" "runcommand" "sftp" "share" "sms" "systemvolume" "telephony" ];
      type = "phone";
    };

    "org/gnome/shell/extensions/just-perfection" = {
      activities-button = false;
      notification-banner-position = 5;
      osd-position = 6;
      panel = true;
      panel-size = 48;
      theme = true;
      window-demands-attention-focus = true;
      window-maximized-on-create = true;
    };

    "org/gnome/shell/extensions/nightthemeswitcher/commands" = {
      enabled = true;
    };

    "org/gnome/shell/extensions/nightthemeswitcher/time" = {
      manual-schedule = true;
    };

    "org/gnome/shell/extensions/one-window-wonderland" = {
      gap-size = 32;
    };

    "org/gnome/shell/extensions/paperwm" = {
      default-focus-mode = 1;
      horizontal-margin = 16;
      last-used-display-server = "Wayland";
      open-window-position = 0;
      open-window-position-option-left = false;
      open-window-position-option-right = true;
      restore-attach-modal-dialogs = "false";
      restore-edge-tiling = "false";
      restore-keybinds = ''
        {"restore-shortcuts":{"bind":"[\\"<Super>Escape\\"]","schema_id":"org.gnome.mutter.wayland.keybindings"},"switch-panels":{"bind":"[\\"<Control><Alt>Tab\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"switch-to-workspace-left":{"bind":"[\\"<Super>Page_Up\\",\\"<Super><Alt>Left\\",\\"<Control><Alt>Left\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"switch-group-backward":{"bind":"[\\"<Shift><Super>Above_Tab\\",\\"<Shift><Alt>Above_Tab\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"move-to-monitor-down":{"bind":"[\\"<Super><Shift>Down\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"switch-group":{"bind":"[\\"<Super>Above_Tab\\",\\"<Alt>Above_Tab\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"move-to-workspace-left":{"bind":"[\\"<Super><Shift>Page_Up\\",\\"<Super><Shift><Alt>Left\\",\\"<Control><Shift><Alt>Left\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"move-to-workspace-right":{"bind":"[\\"<Super><Shift>Page_Down\\",\\"<Super><Shift><Alt>Right\\",\\"<Control><Shift><Alt>Right\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"switch-panels-backward":{"bind":"[\\"<Shift><Control><Alt>Tab\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"move-to-workspace-up":{"bind":"[\\"<Control><Shift><Alt>Up\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"switch-to-workspace-right":{"bind":"[\\"<Super>Page_Down\\",\\"<Super><Alt>Right\\",\\"<Control><Alt>Right\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"move-to-workspace-down":{"bind":"[\\"<Control><Shift><Alt>Down\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"switch-applications":{"bind":"[\\"<Super>Tab\\",\\"<Alt>Tab\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"switch-to-workspace-last":{"bind":"[\\"<Super>End\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"switch-applications-backward":{"bind":"[\\"<Shift><Super>Tab\\",\\"<Shift><Alt>Tab\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"move-to-monitor-up":{"bind":"[\\"<Super><Shift>Up\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"rotate-video-lock-static":{"bind":"[\\"<Super>o\\",\\"XF86RotationLockToggle\\"]","schema_id":"org.gnome.settings-daemon.plugins.media-keys"},"close":{"bind":"[\\"<super>q\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"move-to-monitor-left":{"bind":"[\\"<Shift><Super>Page_Up\\"]","schema_id":"org.gnome.desktop.wm.keybindings"},"move-to-monitor-right":{"bind":"[\\"<Shift><Super>Page_Down\\"]","schema_id":"org.gnome.desktop.wm.keybindings"}}
      '';
      restore-workspaces-only-on-primary = "true";
      selection-border-size = 16;
      show-focus-mode-icon = false;
      show-open-position-icon = false;
      show-window-position-bar = false;
      show-workspace-indicator = false;
      vertical-margin = 16;
      vertical-margin-bottom = 16;
      window-gap = 32;
    };

    "org/gnome/shell/extensions/paperwm/keybindings" = {
      center-horizontally = [ "" ];
      close-window = [ "<Super>q" ];
      cycle-height-backwards = [ "" ];
      cycle-width-backwards = [ "" ];
      live-alt-tab = [ "" ];
      live-alt-tab-backward = [ "" ];
      live-alt-tab-scratch = [ "" ];
      live-alt-tab-scratch-backward = [ "" ];
      move-down = [ "<Shift><Super>Down" ];
      move-down-workspace = [ "<Shift><Super>Page_Down" ];
      move-left = [ "<Shift><Super>Left" ];
      move-monitor-above = [ "<Shift><Control>Up" ];
      move-monitor-below = [ "<Shift><Control>Down" ];
      move-monitor-left = [ "<Shift><Control>Left" ];
      move-monitor-right = [ "<Shift><Control>Right" ];
      move-previous-workspace = [ "" ];
      move-previous-workspace-backward = [ "" ];
      move-right = [ "<Shift><Super>Right" ];
      move-space-monitor-above = [ "" ];
      move-space-monitor-below = [ "" ];
      move-space-monitor-left = [ "" ];
      move-space-monitor-right = [ "" ];
      move-up = [ "<Shift><Super>Up" ];
      move-up-workspace = [ "<Shift><Super>Page_Up" ];
      new-window = [ "" ];
      previous-workspace = [ "" ];
      previous-workspace-backward = [ "" ];
      swap-monitor-above = [ "" ];
      swap-monitor-below = [ "" ];
      swap-monitor-left = [ "" ];
      swap-monitor-right = [ "" ];
      switch-focus-mode = [ "" ];
      switch-monitor-above = [ "" ];
      switch-monitor-below = [ "" ];
      switch-monitor-left = [ "" ];
      switch-monitor-right = [ "" ];
      switch-open-window-position = [ "" ];
      toggle-scratch = [ "<Shift><Alt>BackSpace" ];
      toggle-scratch-layer = [ "<Alt>BackSpace" ];
      toggle-scratch-window = [ "" ];
      toggle-top-and-position-bar = [ "" ];
    };

    "org/gnome/shell/extensions/paperwm/workspaces" = {
      list = [ "40123743-0828-4f2c-9461-5be51dd789b0" "ffe11e06-55d3-4da3-b05d-ad1ce739a94f" "ee38ad17-4121-4535-86cb-824ec742ae49" "b95a4a25-8bc0-4161-9dc4-db890530c9cd" ];
    };

    "org/gnome/shell/extensions/paperwm/workspaces/40123743-0828-4f2c-9461-5be51dd789b0" = {
      background = "";
      color = "rgb(143,240,164)";
      index = 0;
    };

    "org/gnome/shell/extensions/paperwm/workspaces/b95a4a25-8bc0-4161-9dc4-db890530c9cd" = {
      background = "";
      color = "rgb(255,120,0)";
      index = 3;
    };

    "org/gnome/shell/extensions/paperwm/workspaces/ee38ad17-4121-4535-86cb-824ec742ae49" = {
      background = "";
      color = "rgb(224,27,36)";
      index = 2;
    };

    "org/gnome/shell/extensions/paperwm/workspaces/ffe11e06-55d3-4da3-b05d-ad1ce739a94f" = {
      background = "";
      color = "rgb(129,61,156)";
      index = 1;
    };

    "org/gnome/shell/extensions/space-bar/appearance" = {
      active-workspace-border-radius = 4;
      active-workspace-border-width = 0;
      active-workspace-font-weight = "600";
      active-workspace-padding-h = 4;
      active-workspace-padding-v = 4;
      empty-workspace-border-radius = 4;
      empty-workspace-border-width = 0;
      empty-workspace-font-weight = "600";
      empty-workspace-padding-h = 4;
      empty-workspace-padding-v = 4;
      inactive-workspace-border-radius = 4;
      inactive-workspace-border-width = 0;
      inactive-workspace-font-weight = "600";
      inactive-workspace-padding-h = 4;
      inactive-workspace-padding-v = 4;
      workspace-margin = 8;
      workspaces-bar-padding = 8;
    };

    "org/gnome/shell/extensions/space-bar/behavior" = {
      always-show-numbers = false;
      indicator-style = "workspaces-bar";
      scroll-wheel = "disabled";
      show-empty-workspaces = true;
      smart-workspace-names = false;
    };

    "org/gnome/shell/extensions/space-bar/shortcuts" = {
      enable-activate-workspace-shortcuts = true;
      enable-move-to-workspace-shortcuts = true;
    };

    "org/gnome/shell/extensions/space-bar/state" = {
      version = 27;
    };

    "org/gnome/shell/extensions/vertical-workspaces" = {
      app-grid-incomplete-pages = false;
      center-app-grid = false;
      dash-isolate-workspaces = true;
      dash-position = 4;
      overview-mode = 0;
      panel-position = 0;
      recent-files-search-provider-module = true;
      running-dot-style = 0;
      show-search-entry = false;
      startup-state = 0;
      ws-switcher-wraparound = true;
      ws-thumbnails-full = true;
      ws-thumbnails-position = 0;
    };

    "org/gnome/shell/keybindings" = {
      focus-active-notification = [];
      shift-overview-down = [];
      shift-overview-up = [];
      switch-to-application-1 = [];
      switch-to-application-2 = [];
      switch-to-application-3 = [];
      switch-to-application-4 = [];
      switch-to-application-5 = [];
      toggle-overview = [ "<Control>Down" ];
    };

    "org/gnome/shell/world-clocks" = {
      locations = [ (mkVariant [ (mkUint32 2) (mkVariant [ "Chicago" "KMDW" true [ (mkTuple [ 0.7292712893531614 (-1.5316185371029443) ]) ] [ (mkTuple [ 0.7304208679182801 (-1.529781996944241) ]) ] ]) ]) (mkVariant [ (mkUint32 2) (mkVariant [ "San Francisco" "KOAK" true [ (mkTuple [ 0.6583284898216201 (-2.133408063190589) ]) ] [ (mkTuple [ 0.659296885757089 (-2.136621860115334) ]) ] ]) ]) ];
    };

    "org/gnome/software" = {
      check-timestamp = mkInt64 1724750280;
      first-run = false;
      update-notification-timestamp = mkInt64 1724663342;
    };

    "org/gnome/tweaks" = {
      show-extensions-notice = false;
    };

    "org/gtk/gtk4/settings/color-chooser" = {
      custom-colors = [ (mkTuple [ 0.1921568661928177 0.30588236451148987 0.42352941632270813 1.0 ]) (mkTuple [ 0.4000000059604645 0.21960784494876862 0.13333334028720856 1.0 ]) (mkTuple [ 0.2666666805744171 0.33725491166114807 0.19607843458652496 1.0 ]) (mkTuple [ 0.33725491166114807 0.32156863808631897 0.2823529541492462 1.0 ]) ];
      selected-color = mkTuple [ true 0.5607843399047852 0.9411764740943909 0.6431372761726379 1.0 ];
    };

    "org/gtk/gtk4/settings/file-chooser" = {
      date-format = "regular";
      location-mode = "path-bar";
      show-hidden = false;
      show-size-column = true;
      show-type-column = true;
      sidebar-width = 380;
      sort-column = "name";
      sort-directories-first = true;
      sort-order = "ascending";
      type-format = "category";
      view-type = "list";
      window-size = mkTuple [ 1256 1366 ];
    };

    "org/gtk/settings/debug" = {
      enable-inspector-keybinding = true;
      inspector-warning = true;
    };

    "org/gtk/settings/file-chooser" = {
      date-format = "regular";
      location-mode = "path-bar";
      show-hidden = true;
      show-size-column = true;
      show-type-column = true;
      sidebar-width = 498;
      sort-column = "name";
      sort-directories-first = false;
      sort-order = "ascending";
      type-format = "category";
      window-position = mkTuple [ 26 23 ];
      window-size = mkTuple [ 1244 1324 ];
    };

  };
}
