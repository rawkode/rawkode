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

      config = lib.mkIf (cfg.enable && cfg.mail.personalizedSmartReplies) {
        # Only set this when enabled: writing com.apple.mail's sandboxed
        # preferences domain via `defaults write` fails non-interactively
        # ("Could not write domain com.apple.mail; exiting"), and any write to
        # it -- even `false` -- aborts the whole userDefaults activation step
        # and breaks `nh darwin switch`.
        system.defaults.CustomUserPreferences."com.apple.mail".PersonalizedSmartReplies = true;
      };
    };
}
