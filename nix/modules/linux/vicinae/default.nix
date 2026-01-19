{
  flake.homeModules.vicinae = _: {
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
      "Super+Space" = {
        action = {
          spawn = [
            "vicinae"
            #"toggle"
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
      "Super+e" = {
        action = {
          spawn = [
            "vicinae"
            "vicinae://extensions/vicinae/vicinae/search-emojis"
          ];
        };
      };
      "Super+C" = {
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
