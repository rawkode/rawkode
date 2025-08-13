{ pkgs, ... }:
let
  vivaldi-wayland = (
    pkgs.vivaldi.override {
      commandLineArgs = [
        "--enable-features=UseOzonePlatform" # Better Wayland support
        "--ozone-platform=wayland" # Native Wayland support
        "--enable-features=VaapiVideoDecoder" # Hardware video acceleration
        "--disable-features=UseChromeOSDirectVideoDecoder" # Prevents conflicts with VAAPI
      ];
      proprietaryCodecs = true;
      enableWidevine = true;
    }
  );
in
{
  environment.systemPackages = [
    vivaldi-wayland
    pkgs.vivaldi-ffmpeg-codecs
    pkgs.widevine-cdm
  ];

  environment.etc = {
    "1password/custom_allowed_browsers" = {
      text = ''
        vivaldi-bin
      '';
      mode = "0755";
    };
  };
}
