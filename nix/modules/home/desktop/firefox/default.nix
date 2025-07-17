{ pkgs, ... }:
{
  stylix.targets.firefox.profileNames = [ "rawkode" ];

  programs.firefox = {
    enable = true;
    package = null;
    profiles.rawkode = {
      id = 0;
      isDefault = true;

      search = {
        force = true;
        default = "kagi";
        privateDefault = "ddg";
        order = [
          "kagi"
          "ghc"
          "nixpkgs"
          "ddg"
          "google"
        ];
        engines = {
          kagi = {
            name = "Kagi";
            urls = [ { template = "https://kagi.com/search?q={searchTerms}"; } ];
            icon = "https://kagi.com/favicon.ico";
          };
          ghc = {
            name = "GitHub Code Search";
            urls = [ { template = "https://cs.github.com/search?type=code&q={searchTerms}"; } ];
            icon = "https://github.githubassets.com/pinned-octocat.svg";
          };
          nixpkgs = {
            name = "Nixpkgs Search";
            urls = [ { template = "https://search.nixos.org/packages?channel=unstable&query={searchTerms}"; } ];
            icon = "https://nixos.org/favicon.ico";
          };
          bing.metaData.hidden = true;
          ebay.metaData.hidden = true;
        };
      };

      bookmarks = { };

      settings = {
        # Vertical Tabs
        "sidebar.verticalTabs" = true;
        "sidebar.position_start" = false;

        # Pretend to be Chrome so websites let us work
        "general.useragent.override" =
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

        # My Browser
        "browser.startup.homepage" = "https://www.kagi.com/assistant";
        "browser.startup.page" = 3; # Restore Tabs
        "browser.toolbars.bookmarks.visibility" = "never";

        # I Like Sync for NixOS <-> Android
        "identity.fxaccounts.enabled" = true;
        "services.sync.engine.addons" = true;
        "services.sync.engine.addresses.available" = false;
        "services.sync.engine.creditcards" = false;
        "services.sync.engine.passwords" = false;

        "browser.uiCustomization.navBarWhenVerticalTabs" = builtins.toJSON {
          #{"placements":{"widget-overflow-fixed-list":[],"unified-extensions-area":["_bbb880ce-43c9-47ae-b746-c3e0096c5b76_-browser-action","_74145f27-f039-47ce-a470-a662b129930a_-browser-action","firefox-translations-addon_mozilla_org-browser-action"],"nav-bar":["back-button","stop-reload-button","forward-button","vertical-spacer","customizableui-special-spring8","_testpilot-containers-browser-action","urlbar-container","inodhwnfgtr463428675drebcs_jetpack-browser-action","_d634138d-c276-4fc8-924b-40a0ea21d284_-browser-action","customizableui-special-spring7","downloads-button","ublock0_raymondhill_net-browser-action","reset-pbm-toolbar-button","unified-extensions-button"],"toolbar-menubar":["menubar-items"],"TabsToolbar":[],"vertical-tabs":["tabbrowser-tabs"],"PersonalToolbar":["personal-bookmarks"]},"seen":["save-to-pocket-button","developer-button","ublock0_raymondhill_net-browser-action","_testpilot-containers-browser-action","reset-pbm-toolbar-button","profiler-button","_bbb880ce-43c9-47ae-b746-c3e0096c5b76_-browser-action","inodhwnfgtr463428675drebcs_jetpack-browser-action","_74145f27-f039-47ce-a470-a662b129930a_-browser-action","firefox-translations-addon_mozilla_org-browser-action","_d634138d-c276-4fc8-924b-40a0ea21d284_-browser-action","screenshot-button"],"dirtyAreaCache":["nav-bar","PersonalToolbar","toolbar-menubar","TabsToolbar","widget-overflow-fixed-list","unified-extensions-area","vertical-tabs"],"currentVersion":23,"newElementCount":8}
          "placements" = {
            "widget-overflow-fixed-list" = [ ];
            "unified-extensions-area" = [
              "_bbb880ce-43c9-47ae-b746-c3e0096c5b76_-browser-action"
              "_74145f27-f039-47ce-a470-a662b129930a_-browser-action"
              "firefox-translations-addon_mozilla_org-browser-action"
              "_d634138d-c276-4fc8-924b-40a0ea21d284_-browser-action"
            ];
            "nav-bar" = [
              "back-button"
              "stop-reload-button"
              "forward-button"
              "vertical-spacer"
              "customizableui-special-spring8"
              "_testpilot-containers-browser-action"
              "urlbar-container"
              "inodhwnfgtr463428675drebcs_jetpack-browser-action"
              "customizableui-special-spring7"
              "downloads-button"
              "ublock0_raymondhill_net-browser-action"
              "reset-pbm-toolbar-button"
              "unified-extensions-button"
            ];
            "toolbar-menubar" = [ "menubar-items" ];
            "TabsToolbar" = [ ];
            "vertical-tabs" = [ "tabbrowser-tabs" ];
            "PersonalToolbar" = [ "personal-bookmarks" ];
          };
        };

        # Performance
        "gfx.webrender.all" = true;

        # PWAs
        "browser.taskbarTabs.enabled" = true;

        # Privacy & Security
        "browser.contentblocking.category" = "strict";
        "privacy.sanitize.sanitizeOnShutdown" = true;
        "privacy.trackingprotection.enabled" = true;
        "privacy.userContext.enabled" = true;
        "privacy.userContext.ui.enabled" = true;
        "privacy.window.name.update.enabled" = true;
        "security.cert_pinning.enforcement_level" = 2;
        "security.mixed_content.block_display_content" = true;
        "security.OCSP.require" = true;
        "security.pki.crlite_mode" = 2;
        "security.remote_settings.crlite_filters.enabled" = true;
        "security.ssl.require_safe_negotiation" = true;

        # Just use 1Password
        "browser.formfill.enable" = false;
        "extensions.formautofill.addresses.enabled" = false;
        "extensions.formautofill.available" = "off";
        "extensions.formautofill.creditCards.available" = false;
        "extensions.formautofill.creditCards.enabled" = false;
        "extensions.formautofill.heuristics.enabled" = false;
        "signon.autofillForms" = false;
        "signon.formlessCapture.enabled" = false;
        "signon.rememberSignons" = false;

        # Stay Out of my Way
        "browser.aboutConfig.showWarning" = false;
        "browser.download.alwaysOpenPanel" = false;
        "browser.newtabpage.enabled" = false;
        "browser.search.suggest.enabled" = false;
        "browser.sessionstore.warnOnQuit" = true;

        # Disable Bloat
        "browser.discovery.enabled" = false;
        "browser.newtabpage.activity-stream.feeds.discoverystreamfeed" = false;
        "browser.newtabpage.activity-stream.feeds.section.topstories" = false;
        "browser.newtabpage.activity-stream.feeds.snippets" = false;
        "browser.newtabpage.activity-stream.feeds.telemetry" = false;
        "browser.newtabpage.activity-stream.section.highlights.includePocket" = false;
        "browser.newtabpage.activity-stream.showSponsored" = false;
        "browser.newtabpage.activity-stream.showSponsoredTopSites" = false;
        "browser.newtabpage.activity-stream.telemetry" = false;
        "browser.ping-centre.telemetry" = false;
        "browser.tabs.firefox-view" = false;
        "browser.tabs.firefox-view-next" = false;
        "toolkit.telemetry.archive.enabled" = false;
        "toolkit.telemetry.bhrPing.enabled" = false;
        "toolkit.telemetry.coverage.opt-out" = true;
        "toolkit.telemetry.enabled" = false;
        "toolkit.telemetry.firstShutdownPing.enabled" = false;
        "toolkit.telemetry.newProfilePing.enabled" = false;
        "toolkit.telemetry.server" = "data:,";
        "toolkit.telemetry.shutdownPingSender.enabled" = false;
        "toolkit.telemetry.unified" = false;
        "toolkit.telemetry.updatePing.enabled" = false;
      };
    };
  };

  home.sessionVariables = {
    MOZ_ENABLE_WAYLAND = "1";
  };
}
