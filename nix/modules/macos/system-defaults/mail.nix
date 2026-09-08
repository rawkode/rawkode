{
  flake.darwinModules.macos-system-defaults-mail =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults.mail.personalizedSmartReplies = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Generate Mail smart replies that reflect the user's writing style";
      };

      config = lib.mkIf cfg.enable {
        system.defaults.CustomUserPreferences."com.apple.mail".PersonalizedSmartReplies =
          cfg.mail.personalizedSmartReplies;
      };
    };
}
