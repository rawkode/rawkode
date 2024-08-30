{ channels, ... }:

final: prev: {

  vivaldi = (
    prev.vivaldi.overrideAttrs (oldAttrs: rec {
      version = "6.9.3447.37";

      src = prev.fetchurl {
        url = "https://downloads.vivaldi.com/stable/vivaldi-stable_${version}-1_amd64.deb";
        hash = "sha256-+h7SHci8gZ+epKFHD0PiXyME2xT+loD2KXpJGFCfIFg=";
      };
    })
  );
}
