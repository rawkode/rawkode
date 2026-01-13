{
  flake.homeModules.ghostty =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      stylixColors = lib.attrByPath [
        "stylix"
        "colors"
        "withHashtag"
      ] null config;

      baseSettings = {
          auto-update = "off";

          font-family = "Monaspace Neon";
          font-size = 16;

          shell-integration = "detect";

          mouse-hide-while-typing = true;

          clipboard-read = "allow";
          clipboard-write = "allow";
          copy-on-select = "clipboard";
          clipboard-trim-trailing-spaces = true;
          clipboard-paste-protection = true;

          confirm-close-surface = false;

          focus-follows-mouse = true;

          # Split visibility improvements
          unfocused-split-opacity = 0.5;

          window-decoration = true;
          window-colorspace = "display-p3";
          window-padding-x = 16;
          window-padding-y = 16;
          window-padding-balance = true;

          keybind = [
            "ctrl+space=toggle_command_palette"
            "super+k=toggle_command_palette"

            "super+v=paste_from_clipboard"
            "shift+insert=paste_from_clipboard"
            "ctrl+shift+v=paste_from_clipboard"

            "super+t=new_tab"
            "super+q=close_tab"
            "ctrl+page_up=previous_tab"
            "ctrl+page_down=next_tab"

            "ctrl+plus=increase_font_size:1"
            "ctrl+minus=decrease_font_size:1"
            "ctrl+0=reset_font_size"

            "ctrl+shift+p=toggle_command_palette"

            "super+z=toggle_split_zoom"

            "alt+shift+backslash=new_split:right"
            "alt+backslash=new_split:down"

            "alt+arrow_down=goto_split:down"
            "alt+arrow_up=goto_split:up"
            "alt+arrow_left=goto_split:left"
            "alt+arrow_right=goto_split:right"
          ];
        }
        // lib.optionalAttrs (stylixColors != null) {
          split-divider-color = lib.mkDefault stylixColors.base0D;
          unfocused-split-fill = lib.mkDefault stylixColors.base0D;
        };

      linuxSettings =
        if pkgs.stdenv.isLinux then
          {
            gtk-single-instance = true;
            gtk-titlebar = true;
          }
        else
          { };

      darwinSettings = if pkgs.stdenv.isDarwin then { } else { };

      ghosttySettings = baseSettings // linuxSettings // darwinSettings;

      renderValue =
        value:
        if builtins.isBool value then
          if value then "true" else "false"
        else if builtins.isInt value || builtins.isFloat value then
          builtins.toString value
        else if builtins.isString value then
          value
        else
          throw "Unsupported ghostty setting value type";

      ghosttyConfigText =
        let
          lines = lib.flatten (
            lib.mapAttrsToList (
              name: value:
              if builtins.isList value then
                map (item: "${name} = ${renderValue item}") value
              else
                [ "${name} = ${renderValue value}" ]
            ) ghosttySettings
          );
        in
        lib.concatStringsSep "\n" lines + "\n";
    in
    {
      programs.ghostty = {
        enable = true;
        package = null;
        enableBashIntegration = false;
        enableFishIntegration = false;

        clearDefaultKeybinds = true;

        # All options are documented at
        # https://ghostty.org/docs/config/reference
        settings = ghosttySettings;
      };

      # Ghostty looks for its config under Application Support on macOS.
      home.file = lib.mkIf pkgs.stdenv.isDarwin {
        "Library/Application Support/com.mitchellh.ghostty/config" = {
          text = ghosttyConfigText;
        };
      };
    };

  flake.nixosModules.ghostty =
    {
      inputs,
      pkgs,
      lib,
      ...
    }:
    lib.mkIf (!pkgs.stdenv.isDarwin) {
      environment.systemPackages = [
        inputs.ghostty.packages.${pkgs.stdenv.hostPlatform.system}.default
      ];
    };

  flake.darwinModules.ghostty =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "ghostty" ];
      };
    };
}
