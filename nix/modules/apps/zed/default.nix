{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "zed";

  common.home =
    { pkgs, isDarwin, ... }:
    let
      modifier = if isDarwin then "cmd" else "ctrl";
      keymap = ''
        [
          {
            "bindings": {
              "${modifier}-shift-e": "project_panel::ToggleFocus",
              "${modifier}-shift-l": "project_panel::CollapseAllEntries",

              "${modifier}-l": [
                "workspace::SendKeystrokes",
                "${modifier}-k ${modifier}-w ${modifier}-shift-e ${modifier}-shift-l ${modifier}-shift-e"
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
    in
    {
      home.packages = lib.optionals (!isDarwin) [ pkgs.zed-editor ];

      xdg.configFile."zed/keymap.json".text = keymap;

      xdg.configFile."zed/settings.json".text = ''
        {
          "theme": "Rosé Pine Moon",
          "font_family": "Monaspace Neon",
          "font_size": 24,
          "vim_mode": false,
          "tab_size": 2,
          "format_on_save": "on",
          "autosave": "on_focus_change",
          "project_panel": {
            "dock": "right"
          },
          "agent": {
            "dock": "left"
          },
          "git_panel": {
            "dock": "right"
          },
          "collaboration_panel": {
            "dock": "right"
          },
          "cursor_blink": false,
          "scrollbar": {
            "show": "auto"
          },
          "git": {
            "inline_blame": {
              "enabled": true
            }
          }
        }
      '';
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "zed" ];
      };
    };
}
