{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
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
      options.rawkOS.apps.zed.configDir = lib.mkOption {
        type = lib.types.str;
        default = "${config.home.homeDirectory}/Code/src/github.com/rawkode/rawkode/nix/modules/apps/zed";
        description = "Absolute path to the editable Zed config files in the dotfiles checkout.";
      };

      config = {
        home.packages = lib.optionals (!isDarwin) [ pkgs.zed-editor ];

        home.activation.zedConfigSymlinks = config.lib.dag.entryAfter [ "linkGeneration" ] ''
          mkdir -p ${lib.escapeShellArg "${config.home.homeDirectory}/.config/zed"}
          ln -sfn \
            ${lib.escapeShellArg "${cfg.configDir}/${keymapFile}"} \
            ${lib.escapeShellArg "${config.home.homeDirectory}/.config/zed/keymap.json"}
          ln -sfn \
            ${lib.escapeShellArg "${cfg.configDir}/settings.json"} \
            ${lib.escapeShellArg "${config.home.homeDirectory}/.config/zed/settings.json"}
        '';
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
