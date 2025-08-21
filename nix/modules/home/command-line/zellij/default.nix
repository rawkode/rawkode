{ pkgs, ... }:
{
  programs.zellij = {
    enable = true;

    attachExistingSession = true;
    exitShellOnExit = true;

    settings = {
      default_mode = "normal";
      default_layout = "compact";
      mouse_mode = false;
      pane_frames = false;
      # simplified_ui = false;
      copy_on_select = true;
      ui = {
        pane_frames = {
          hide_session_name = true;
        };
      };

      keybinds = {
        normal = {
          "bind \"Ctrl y\"" = {
            "LaunchOrFocusPlugin \"file:~/.config/zellij/plugins/zellij_forgot.wasm\"" = {
              floating = false;
            };
          };
          "bind \"Ctrl PageDown\"" = {
            GoToNextTab = { };
          };
          "bind \"Ctrl PageUp\"" = {
            GoToPreviousTab = { };
          };
          "bind \"Alt Left\"" = {
            MoveFocus = "Left";
          };
          "bind \"Alt Right\"" = {
            MoveFocus = "Right";
          };
          "bind \"Alt Up\"" = {
            MoveFocus = "Up";
          };
          "bind \"Alt Down\"" = {
            MoveFocus = "Down";
          };
        };
      };
    };
  };

  xdg.configFile = {
    "zellij/plugins/zellij_forgot.wasm".source = pkgs.fetchurl {
      url = "https://github.com/karimould/zellij-forgot/releases/download/0.4.2/zellij_forgot.wasm";
      sha256 = "sha256-MRlBRVGdvcEoaFtFb5cDdDePoZ/J2nQvvkoyG6zkSds=";
    };
  };
}
