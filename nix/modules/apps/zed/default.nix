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

      keymap = [
        {
          bindings = {
            "${modifier}-shift-e" = "project_panel::ToggleFocus";
            "${modifier}-shift-l" = "project_panel::CollapseAllEntries";
            "${modifier}-l" = [
              "workspace::SendKeystrokes"
              "${modifier}-k ${modifier}-w ${modifier}-shift-e ${modifier}-shift-l ${modifier}-shift-e"
            ];
          };
        }
        { context = "Workspace"; }
        { context = "Editor"; }
      ];

      settings = {
        theme = {
          mode = "system";
          dark = "Catppuccin Mocha";
          light = "Catppuccin Latte";
        };
        icon_theme = {
          mode = "system";
          dark = "Catppuccin Mocha";
          light = "Catppuccin Latte";
        };

        buffer_font_family = "Monaspace Neon";
        buffer_font_size = 16;
        ui_font_family = "Monaspace Neon";
        ui_font_size = 14;

        vim_mode = false;
        tab_size = 2;
        soft_wrap = "editor_width";
        cursor_blink = false;
        show_whitespaces = "boundary";
        format_on_save = "on";
        autosave = "on_focus_change";
        linked_edits = true;
        extend_comment_on_newline = true;

        indent_guides = {
          enabled = true;
          coloring = "indent_aware";
        };

        inlay_hints = {
          enabled = true;
          show_type_hints = true;
          show_parameter_hints = true;
          show_other_hints = true;
        };

        scrollbar = {
          show = "auto";
          cursors = true;
          git_diff = true;
          search_results = true;
          diagnostics = true;
        };

        git = {
          inline_blame = {
            enabled = true;
          };
        };

        project_panel = {
          dock = "right";
          auto_reveal_entries = true;
        };
        agent = {
          dock = "left";
        };
        git_panel = {
          dock = "right";
        };
        collaboration_panel = {
          dock = "right";
        };
        tab_bar = {
          show_nav_history_buttons = false;
        };

        terminal = {
          font_family = "Monaspace Neon";
          font_size = 14;
          copy_on_select = true;
        };

        telemetry = {
          metrics = false;
          diagnostics = false;
        };

        file_scan_exclusions = [
          "**/.git"
          "**/.svn"
          "**/.hg"
          "**/CVS"
          "**/.DS_Store"
          "**/Thumbs.db"
          "**/.classpath"
          "**/.settings"
          "**/node_modules"
          "**/target"
          "**/.direnv"
          "**/result"
        ];

        languages = {
          Markdown = {
            soft_wrap = "editor_width";
          };
          Nix = {
            formatter.external = {
              command = "nixfmt";
            };
          };
        };

        lsp = {
          rust-analyzer = {
            initialization_options = {
              check = {
                command = "clippy";
              };
            };
          };
        };

        auto_install_extensions = {
          catppuccin = true;
          nix = true;
          toml = true;
          biome = true;
          sql = true;
          docker-compose = true;
          dockerfile = true;
          editorconfig = true;
          git-firefly = true;
          html = true;
        };

        profiles = {
          screenshare = {
            buffer_font_size = 24;
            ui_font_size = 24;
          };
        };
      };
    in
    {
      home.packages = lib.optionals (!isDarwin) [ pkgs.zed-editor ];

      xdg.configFile."zed/keymap.json".text = builtins.toJSON keymap;
      xdg.configFile."zed/settings.json".text = builtins.toJSON settings;
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
