{ pkgs, ... }:
let
  vivaldi-wayland = (
    pkgs.vivaldi.override {
      commandLineArgs = [ "--ozone-platform=wayland" ];
      proprietaryCodecs = true;
      enableWidevine = true;
    }
  );
in
{
  environment.systemPackages = [
    vivaldi-wayland
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
