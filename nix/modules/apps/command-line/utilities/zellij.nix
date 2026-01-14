{
  flake.homeModules.zellij =
    { pkgs, ... }:
    {
      programs.zellij = {
        enable = true;

        enableFishIntegration = false;

        attachExistingSession = false;
        exitShellOnExit = false;

        settings = {
          default_mode = "normal";
          default_layout = "compact";
          show_startup_tips = false;
          mouse_mode = true;
          pane_frames = false;
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
    };
}
