{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "firefox-nightly";

  # Stylix's Firefox target is absent when Stylix is disabled, so gate it on
  # `stylixHome` rather than referencing `stylix.*` unconditionally.
  common.home =
    {
      lib,
      stylixHome ? false,
      ...
    }:
    lib.optionalAttrs stylixHome {
      stylix.targets.firefox.profileNames = [ "default" ];
    };

  linux.home =
    { pkgs, ... }:
    let
      firefoxNightly =
        inputs.firefox-nightly.packages.${pkgs.stdenv.hostPlatform.system}.firefox-nightly-bin;
      flipperAddon = inputs.flipper.packages.${pkgs.stdenv.hostPlatform.system}.firefox-addon;
      flipperUuid = "d960c516-d2b1-443e-ba53-1b047c263456";
    in
    {
      programs.firefox = {
        enable = true;
        package = firefoxNightly;
        configPath = ".mozilla/firefox";
        profiles.default = {
          id = 0;
          path = "3pzugki6.default";
          isDefault = true;
          settings = {
            "xpinstall.signatures.required" = false;
            # Enable add-ons placed in the profile directory (scope 1) without a prompt.
            "extensions.autoDisableScopes" = 14;
            "privacy.userContext.enabled" = true;
            "privacy.userContext.ui.enabled" = true;
            # Nix owns the profile; Mozilla accounts and Sync are not used.
            "identity.fxaccounts.enabled" = false;
            # Extension versions come from Nix, not addons.mozilla.org.
            "extensions.update.enabled" = false;
            "extensions.update.autoUpdateDefault" = false;

            # Tabs, sidebar, and general UI.
            "sidebar.verticalTabs" = true;
            "sidebar.position_start" = false;
            "browser.toolbars.bookmarks.visibility" = "never";
            "browser.bookmarks.showMobileBookmarks" = false;
            # Restore the previous session on startup.
            "browser.startup.page" = 3;
            "general.autoScroll" = true;
            "browser.translation.detectLanguage" = false;
            "browser.translation.ui.show" = false;
            "intl.regional_prefs.use_os_locales" = true;
            "media.eme.enabled" = true;
            "browser.theme.toolbar-theme" = 0;
            "sidebar.main.tools" = "opentabs";
            "browser.uiCustomization.state" = builtins.toJSON {
              placements = {
                widget-overflow-fixed-list = [
                  "ipprotection-button"
                  "sidebar-button"
                  "alltabs-button"
                ];
                unified-extensions-area = [
                  "ublock0_raymondhill_net-browser-action"
                  "firefox-translations-addon_mozilla_org-browser-action"
                  "_bbb880ce-43c9-47ae-b746-c3e0096c5b76_-browser-action"
                ];
                nav-bar = [
                  "back-button"
                  "forward-button"
                  "stop-reload-button"
                  "customizableui-special-spring1"
                  "vertical-spacer"
                  "urlbar-container"
                  # 1Password
                  "_d634138d-c276-4fc8-924b-40a0ea21d284_-browser-action"
                  "customizableui-special-spring2"
                  "downloads-button"
                  "reset-pbm-toolbar-button"
                  "unified-extensions-button"
                  "smartwindow-group-tabs-button"
                  "ai-window-toggle"
                  "fxa-toolbar-menu-button"
                ];
                toolbar-menubar = [ "menubar-items" ];
                TabsToolbar = [ ];
                vertical-tabs = [ "tabbrowser-tabs" ];
                PersonalToolbar = [
                  "import-button"
                  "personal-bookmarks"
                ];
              };
              seen = [
                "reset-pbm-toolbar-button"
                "profiler-button"
                "smartwindow-group-tabs-button"
                "ai-window-toggle"
                "developer-button"
                "screenshot-button"
                "ipprotection-button"
                "_d634138d-c276-4fc8-924b-40a0ea21d284_-browser-action"
                "firefox-translations-addon_mozilla_org-browser-action"
                "_bbb880ce-43c9-47ae-b746-c3e0096c5b76_-browser-action"
                "ublock0_raymondhill_net-browser-action"
              ];
              currentVersion = 28;
            };

            # Pin extension origins: extension storage and the Flipper URL
            # handler below are keyed by these per-profile UUIDs.
            "extensions.webextensions.uuids" = builtins.toJSON {
              "formautofill@mozilla.org" = "6c45b125-116b-4f57-9c74-65352c1db3e3";
              "ipp-activator@mozilla.com" = "3c758992-2d08-43d6-8d73-533b739233cf";
              "pictureinpicture@mozilla.org" = "7d98fcc0-af18-4088-ac20-fe53773fa6ef";
              "addons-search-detection@mozilla.com" = "90a48cb7-566f-47f6-b849-6c65b419b0ca";
              "webcompat@mozilla.org" = "9a310967-e580-48bf-b3e8-4eafebbc122d";
              "newtab@mozilla.org" = "ffbd4f96-920a-4b8b-a728-ca52958f51c5";
              "default-theme@mozilla.org" = "ef121edc-ab52-4f76-ac2b-1e1fc59987ff";
              "{d634138d-c276-4fc8-924b-40a0ea21d284}" = "30d11c2a-19b9-45d8-86f2-51b46691f74a";
              "firefox-translations-addon@mozilla.org" = "b6f4de32-39c5-4eef-aa2e-702298f3d98c";
              "{bbb880ce-43c9-47ae-b746-c3e0096c5b76}" = "059ea1ba-0e83-4ee7-8d31-43df228124c9";
              "uBlock0@raymondhill.net" = "c3e71b44-be61-49a1-a0e6-0fcabb079e9b";
              "flipper@korora.tech" = flipperUuid;
            };

            # Firefox's built-in IP Protection VPN.
            "browser.ipProtection.enabled" = true;
            "browser.ipProtection.egressLocation" = "US";

            # Privacy and security.
            "browser.contentblocking.category" = "strict";
            "privacy.trackingprotection.enabled" = true;
            "privacy.trackingprotection.socialtracking.enabled" = true;
            "privacy.trackingprotection.emailtracking.enabled" = true;
            "privacy.trackingprotection.allow_list.convenience.enabled" = false;
            "privacy.trackingprotection.consentmanager.skip.pbmode.enabled" = false;
            "privacy.annotate_channels.strict_list.enabled" = true;
            "privacy.fingerprintingProtection" = true;
            "privacy.query_stripping.enabled" = true;
            "privacy.query_stripping.enabled.pbmode" = true;
            "network.http.referer.disallowCrossSiteRelaxingDefault.top_navigation" = true;
            "network.dns.disablePrefetch" = true;
            "network.prefetch-next" = false;
            "network.http.speculative-parallel-limit" = 0;
            "dom.security.https_only_mode" = true;
            "dom.security.https_only_mode_ever_enabled" = true;
            "dom.security.https_only_mode_ever_enabled_pbm" = true;
            # 1Password handles credentials and autofill.
            "signon.rememberSignons" = false;
            "signon.autofillForms" = false;
            "signon.generation.enabled" = false;
            "browser.formfill.enable" = false;
            # Clear cache and form data on shutdown; keep history, cookies, and sessions.
            "privacy.sanitize.sanitizeOnShutdown" = true;
            "privacy.clearOnShutdown_v2.formdata" = true;
            "privacy.clearOnShutdown_v2.cookiesAndStorage" = false;
            "privacy.clearOnShutdown_v2.browsingHistoryAndDownloads" = false;

            # New tab page and address bar.
            "browser.newtabpage.activity-stream.showSponsored" = false;
            "browser.newtabpage.activity-stream.showSponsoredTopSites" = false;
            "browser.newtabpage.activity-stream.feeds.section.topstories" = false;
            "browser.newtabpage.activity-stream.feeds.topsites" = false;
            "browser.newtabpage.activity-stream.widgets.enabled" = false;
            "browser.newtabpage.activity-stream.section.highlights.includeBookmarks" = false;
            "browser.newtabpage.activity-stream.section.highlights.includeDownloads" = false;
            "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons" = false;
            "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features" = false;
            "browser.newtabpage.activity-stream.topSitesRows" = 2;
            "browser.newtabpage.activity-stream.newtabWallpapers.user.enabled" = true;
            "browser.newtabpage.activity-stream.newtabWallpapers.wallpaper" = "firefox-g-dark";
            "browser.newtabpage.activity-stream.weather.optInAccepted" = true;
            "browser.newtabpage.activity-stream.weather.optInDisplayed" = false;
            "browser.newtabpage.pinned" = builtins.toJSON [
              null
              null
              {
                url = "https://gemini.google.com/";
                label = "Google Gemini";
              }
            ];
            "browser.urlbar.suggest.searches" = false;
            "browser.urlbar.showSearchSuggestionsFirst" = false;

            # Fonts.
            "font.name.sans-serif.x-western" = "Inter";
            "font.name.serif.x-western" = "Lora";
            "font.name.monospace.x-western" = "MonaspiceNe Nerd Font";
            "font.size.variable.x-western" = 15;
            "font.size.monospace.x-western" = 20;

            # Reader mode colours.
            "reader.color_scheme" = "custom";
            "reader.custom_colors.background" = "#1f2430";
            "reader.custom_colors.foreground" = "#cccac2";
            "reader.custom_colors.selection-highlight" = "#707a8c";
            "reader.custom_colors.unvisited-links" = "#73d0ff";
            "reader.custom_colors.visited-links" = "#d4bfff";
          };

          handlers = {
            force = true;
            mimeTypes = {
              "application/pdf" = {
                action = 3;
                extensions = [ "pdf" ];
              };
              "image/webp" = {
                action = 3;
                extensions = [ "webp" ];
              };
              "image/avif" = {
                action = 3;
                extensions = [ "avif" ];
              };
              "image/jxl" = {
                action = 3;
                extensions = [ "jxl" ];
              };
            };
            schemes = {
              mailto.handlers = [
                {
                  name = "Gmail";
                  uriTemplate = "https://mail.google.com/mail/?extsrc=mailto&url=%s";
                }
              ];
              claude.action = 4;
              vscode.action = 4;
              hermes.action = 4;
              slack.action = 4;
              "ext+flipper" = {
                action = 2;
                handlers = [
                  {
                    name = "Flipper";
                    uriTemplate = "moz-extension://${flipperUuid}/open.html#%s";
                  }
                ];
              };
            };
          };

          # Firefox re-imports this list on every start; bookmarks added in the
          # browser do not survive a restart.
          bookmarks = {
            force = true;
            settings = [
              {
                name = "Bookmarks Toolbar";
                toolbar = true;
                bookmarks = [
                  {
                    name = "Cloudflare";
                    url = "https://dash.cloudflare.com/";
                  }
                  {
                    name = "Rawkode Academy";
                    url = "https://rawkode.academy/";
                  }
                  {
                    name = "VoicePrompt";
                    url = "https://voiceprompt.live/";
                  }
                  {
                    name = "GitHub";
                    url = "https://github.com/";
                  }
                  {
                    name = "Waddle";
                    url = "https://waddle.chat/r/chat";
                  }
                ];
              }
              {
                name = "Multimedia";
                bookmarks = [
                  {
                    name = "Descript";
                    url = "https://web.descript.com/";
                  }
                  {
                    name = "Canva";
                    url = "https://www.canva.com/";
                    tags = [ "Graphics" ];
                  }
                ];
              }
              {
                name = "Rawkode Academy";
                bookmarks = [
                  {
                    name = "RawkodeAcademy/RawkodeAcademy";
                    url = "https://github.com/RawkodeAcademy/RawkodeAcademy";
                  }
                ];
              }
              {
                name = "Social Media";
                bookmarks = [
                  {
                    name = "BlueSky";
                    url = "https://bsky.app/";
                    tags = [ "Social" ];
                  }
                  {
                    name = "LinkedIn";
                    url = "https://www.linkedin.com/";
                    tags = [ "Social" ];
                  }
                  {
                    name = "Mastodon";
                    url = "https://rawkode.social/deck/";
                    tags = [ "Social" ];
                  }
                  {
                    name = "X";
                    url = "https://x.com/";
                    tags = [ "Social" ];
                  }
                ];
              }
            ];
          };

          search = {
            force = true;
            default = "google";
            privateDefault = "google";
          };

          extensions.packages =
            (with pkgs.nur.repos.rycee.firefox-addons; [
              catppuccin-web-file-icons
              firefox-translations
              onepassword-password-manager
              ublock-origin
            ])
            ++ [ flipperAddon ];

          # Keep Firefox's built-in container IDs: Flipper rules address
          # containers by ID.
          containersForce = true;
          containers = {
            RawkodeAcademy = {
              id = 1;
              color = "pink";
              icon = "circle";
            };
            KororaTech = {
              id = 2;
              color = "orange";
              icon = "circle";
            };
          };
        };
      };

      # Firefox prefers the legacy ~/.mozilla path whenever it exists (native
      # messaging hosts guarantee it does), so manage the existing profile there.
      home.file.".mozilla/firefox/profiles.ini".force = true;

      xdg.mimeApps = {
        enable = true;
        defaultApplications."x-scheme-handler/about" = [ "firefox-nightly.desktop" ];
      };
    };

  linux.system =
    { inputs, pkgs, ... }:
    {
      environment.systemPackages = [
        inputs.firefox-nightly.packages.${pkgs.stdenv.hostPlatform.system}.firefox-nightly-bin
      ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "firefox@nightly" ];
      };
    };
}
