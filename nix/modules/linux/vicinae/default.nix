_:
let
  mkApp = import ../../../lib/mkApp.nix;

  vicinaeCache = {
    extra-substituters = [ "https://vicinae.cachix.org/" ];
    extra-trusted-public-keys = [
      "vicinae.cachix.org-1:1kDrfienkGHPYbkpNj1mWTr7Fm1+zcenzgTizIcI3oc="
    ];
  };
in
mkApp {
  name = "vicinae";

  linux.system = _: {
    nix.settings = vicinaeCache;
  };

  linux.home = { lib, ... }: {
    nix.settings = vicinaeCache;

    services.vicinae = {
      enable = true;
      settings = {
        faviconService = "google";
        font = {
          normal = "Monaspace Argon";
          size = 12;
        };
        popToRootOnClose = true;
        rootSearch = {
          searchFiles = false;
        };
        theme = {
          name = "rosepine-dawn";
        };
        window = {
          csd = true;
          opacity = 0.95;
          rounding = 16;
        };
      };
    };

    programs.niri.settings.binds = {
      "Mod+Space" = {
        # Replace DMS's launcher binding while retaining its other shortcuts.
        action = lib.mkForce {
          spawn = [
            "vicinae"
          ];
        };
      };
      "Super+Shift+Space" = {
        action = {
          spawn = [
            "vicinae"
            "vicinae://extensions/vicinae/wm/switch-windows"
          ];
        };
      };
      "Super+E" = {
        action = {
          spawn = [
            "vicinae"
            "vicinae://extensions/vicinae/vicinae/search-emojis"
          ];
        };
      };
      "Super+Alt+V" = {
        action = {
          spawn = [
            "vicinae"
            "vicinae://extensions/vicinae/clipboard/history"
          ];
        };
      };
    };
  };
}
