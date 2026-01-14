{
  flake.homeModules.zed =
    { pkgs, ... }:
    {
      home.packages = [ pkgs.zed-editor ];

      xdg.configFile."zed/keymap.json".text = ''
        [
          {
            "bindings": {
              "ctrl-shift-e": "project_panel::ToggleFocus",
              "ctrl-shift-l": "project_panel::CollapseAllEntries",

              "ctrl-l": [
                "workspace::SendKeystrokes",
                "ctrl-k ctrl-w ctrl-shift-e ctrl-shift-l ctrl-shift-e"
              ]
            }
          },
          {
            "context": "Workspace"
          },
          {
            "context": "Editor"
          }
        ]
      '';

      # Unfortunately, Zed needs to write to this
      # for many different purposes.
      # They really need settings sync
      #
      # xdg.configFile."zed/settings.json".text = ''
      #   {
      #     "theme": "Rosé Pine Moon",
      #     "font_family": "Monaspace Neon",
      #     "font_size": 24,
      #     "vim_mode": false,
      #     "tab_size": 2,
      #     "format_on_save": "on",
      #     "autosave": "on_focus_change",
      #     "project_panel": {
      #       "dock": "right"
      #     },
      #     "agent": {
      #       "dock": "left"
      #     },
      #     "git_panel": {
      #       "dock": "right"
      #     },
      #     "collaboration_panel": {
      #       "dock": "right"
      #     },
      #     "cursor_blink": false,
      #     "scrollbar": {
      #       "show": "auto"
      #     },
      #     "git": {
      #       "inline_blame": {
      #         "enabled": true
      #       }
      #     }
      #   }
      # '';
    };

  flake.darwinModules.zed =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "zed" ];
      };
    };
}
