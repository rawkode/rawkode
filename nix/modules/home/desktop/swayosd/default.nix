{
  config,
  lib,
  osConfig ? { },
  pkgs,
  ...
}:
with lib;
let
  cfg = osConfig.rawkOS.desktop.niri or { enable = false; };
in
{
  config = mkIf cfg.enable {
    services = {
      swayosd = {
        enable = true;
      };
    };

    programs.niri.settings.binds =
      with config.lib.niri.actions;
      let
        sh = spawn "sh" "-c";
      in
      {
        "Caps_Lock".action = sh "sleep 0.1 && ${pkgs.swayosd}/bin/swayosd-client --caps-lock";
        "Caps_Lock".allow-when-locked = true;

        "XF86AudioPlay".action = sh "playerctl" "play-pause";
        "XF86AudioPlay".allow-when-locked = true;

        "XF86AudioNext".action = sh "playerctl" "next";
        "XF86AudioNext".allow-when-locked = true;

        "XF86AudioPrev".action = sh "playerctl" "previous";
        "XF86AudioPrev".allow-when-locked = true;

        "XF86AudioLowerVolume".action = sh "swayosd-client" "--output-volume" "-1";
        "XF86AudioLowerVolume".allow-when-locked = true;

        "XF86AudioRaiseVolume".action = sh "swayosd-client" "--output-volume" "-1";
        "XF86AudioRaiseVolume".allow-when-locked = true;

        "XF86AudioMute".action = sh "swayosd-client" "--output-volume" "mute-toggle";
        "XF86AudioMute".allow-when-locked = true;

        "XF86MonBrightnessUp".action = sh "swayosd-client" "--brightness" "+5";
        "XF86MonBrightnessUp".allow-when-locked = true;

        "XF86MonBrightnessDown".action = sh "swayosd-client" "--brightness" "-5";
        "XF86MonBrightnessDown".allow-when-locked = true;
      };
  };
}
