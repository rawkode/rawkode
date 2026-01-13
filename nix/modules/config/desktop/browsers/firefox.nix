_: {
  flake.homeModules.firefox = _: {
    stylix.targets.firefox.profileNames = [ "rawkode" ];

    programs.firefox = {
      enable = true;
      package = null;
      profiles.rawkode = {
        id = 0;
        isDefault = true;

        search = {
          force = true;
          default = "google";
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
              definedAliases = [ "@ghb" ];
            };
            nixpkgs = {
              name = "Nixpkgs Search";
              urls = [ { template = "https://search.nixos.org/packages?channel=unstable&query={searchTerms}"; } ];
              icon = "https://nixos.org/favicon.ico";
              definedAliases = [ "@nxp" ];
            };

            bing.metaData.hidden = true;
            ebay.metaData.hidden = true;
          };
        };

        bookmarks = { };

        settings = {
          # Vertical Tabs
          "sidebar.verticalTabs" = true;
          "sidebar.position_start" = true;

          # I hate this square search button thing
          "browser.urlbar.scotchBonnet.enableOverride" = false;

          # My Browser
          "browser.startup.homepage" = "about:home";
          "browser.startup.page" = 3; # Restore Session
          "browser.toolbars.bookmarks.visibility" = "never";

          # I Like Sync for NixOS <-> Android
          "identity.fxaccounts.enabled" = true;
          "services.sync.engine.addons" = true;
          "services.sync.engine.addresses.available" = false;
          "services.sync.engine.creditcards" = false;
          "services.sync.engine.passwords" = false;
          "services.sync.prefs.sync.browser.uiCustomization.state" = true;

          # Performance
          "gfx.webrender.all" = true;

          # PWAs
          "browser.taskbarTabs.enabled" = true;

          # Clear on Shutdown
          "privacy.clearOnShutdown_v2.cookiesAndStorage" = false;
          "privacy.clearOnShutdown.cookies" = false;
          "privacy.clearOnShutdown.sessions" = false;
          "privacy.clearSiteData.cookiesAndStorage" = false;
          "privacy.sanitize.sanitizeOnShutdown" = false;
          "services.sync.prefs.sync-seen.privacy.clearOnShutdown.sessions" = false;

          "privacy.clearOnShutdown_v2.cache" = true;
          "privacy.clearOnShutdown_v2.historyFormDataAndDownloads" = true;
          "privacy.clearOnShutdown.cache" = true;
          "privacy.clearOnShutdown.downloads" = true;
          "privacy.clearOnShutdown.formdata" = true;
          "privacy.clearOnShutdown.history" = false;
          "privacy.clearOnShutdown.offlineApps" = true;
          "privacy.clearSiteData.cache" = true;
          "privacy.clearSiteData.historyFormDataAndDownloads" = true;

          # Privacy & Security
          "browser.contentblocking.category" = "strict";
          "browser.discovery.enabled" = false;
          "browser.shopping.experience2023.enabled" = false;
          "browser.shopping.experience2023.opted" = 2;
          "browser.shopping.experience2023.active" = false;
          "extensions.htmlaboutaddons.recommendations.enabled" = false;
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

          # Disable Crash Reports
          "breakpad.reportURL" = "";
          "browser.tabs.crashReporting.sendReport" = false;
          "browser.crashReports.unsubmittedCheck.enabled" = false;
          "browser.crashReports.unsubmittedCheck.autoSubmit2" = false;

          # Disable Bloat
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
  };

  flake.darwinModules.firefox =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "firefox@nightly" ];
      };
    };
}
