{ config, lib, pkgs, ... }:

let
  cfg = config.programs.zed;
in
{
  options.programs.zed = {
    enable = lib.mkEnableOption "Zed editor";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.zed-editor;
      description = "The Zed package to use";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Zed keymap configuration
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

    # Zed settings
    xdg.configFile."zed/settings.json".text = ''
{
  "theme": "Catppuccin Mocha",
  "font_family": "Monaspace Neon",
  "font_size": 16,
  "vim_mode": false,
  "tab_size": 2,
  "format_on_save": "on",
  "autosave": "on_focus_change",
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
}