{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "zed";

  common.home =
    {
      config,
      pkgs,
      isDarwin,
      ...
    }:
    let
      cfg = config.rawkOS.apps.zed;
      keymapFile = if isDarwin then "keymap-darwin.json" else "keymap-linux.json";
    in
    {
      options.rawkOS.apps.zed.enable = lib.mkEnableOption "Zed editor integration" // {
        default = true;
      };

      options.rawkOS.apps.zed.configDir = lib.mkOption {
        type = lib.types.str;
        default = "${config.home.homeDirectory}/Code/src/github.com/rawkode/rawkode/nix/modules/apps/zed";
        description = "Absolute path to the editable Zed config files in the dotfiles checkout.";
      };

      config = lib.mkIf cfg.enable {
        home.packages = lib.optionals (!isDarwin) [ pkgs.zed-editor ];

        home.file = {
          ".config/zed/keymap.json".source =
            config.lib.file.mkOutOfStoreSymlink "${cfg.configDir}/${keymapFile}";
          ".config/zed/settings.json".source =
            config.lib.file.mkOutOfStoreSymlink "${cfg.configDir}/settings.json";
        };

        xdg.mimeApps = lib.mkIf (!isDarwin) {
          enable = true;
          defaultApplications = lib.genAttrs [
            "application/json"
            "application/toml"
            "application/x-shellscript"
            "application/x-yaml"
            "application/xml"
            "text/markdown"
            "text/plain"
            "text/x-python"
            "text/x-rust"
          ] (_: [ "dev.zed.Zed.desktop" ]);
        };
      };
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
