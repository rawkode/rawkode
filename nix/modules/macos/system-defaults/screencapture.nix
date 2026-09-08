{
  flake.darwinModules.macos-system-defaults-screencapture =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults.screencapture = {
        format = lib.mkOption {
          type = lib.types.enum [
            "png"
            "jpg"
            "pdf"
            "tiff"
            "gif"
            "bmp"
          ];
          default = "png";
          description = "Screenshot file format";
        };
        location = lib.mkOption {
          type = lib.types.str;
          default = "~/Screenshots";
          description = "Screenshot save location";
        };
        disableShadow = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Disable shadows in window screenshots";
        };
        includeDate = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Include the date in screenshot filenames";
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults.screencapture = {
          type = cfg.screencapture.format;
          inherit (cfg.screencapture) location;
          disable-shadow = cfg.screencapture.disableShadow;
          include-date = cfg.screencapture.includeDate;
        };
      };
    };
}
