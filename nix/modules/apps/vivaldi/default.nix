{ inputs, ... }:
{
  flake.overlays.vivaldi = _final: prev: {
    vivaldi =
      (prev.vivaldi.override {
        commandLineArgs = [
          "--enable-features=UseOzonePlatform"
          "--ozone-platform=wayland"
          "--enable-features=VaapiVideoDecoder"
          "--disable-features=UseChromeOSDirectVideoDecoder"
        ];
      }).overrideAttrs
        (_oldAttrs:
          let
            version = "7.6.3797.52";
          in
          {
            inherit version;

            src = prev.fetchurl {
              url = "https://downloads.vivaldi.com/stable/vivaldi-stable_${version}-1_amd64.deb";
              hash = "sha256-cDYn6Vj+S/pft5jF2ItSUKIILCGHF++ZhH794BLNxQQ=";
            };
          });
  };

  flake.nixosModules.vivaldi =
    { pkgs, ... }:
    {
      nixpkgs.overlays = [ inputs.self.overlays.vivaldi ];
      environment.systemPackages = [ pkgs.vivaldi ];
    };

  flake.darwinModules.vivaldi =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "vivaldi@snapshot" ];
      };
    };
}
