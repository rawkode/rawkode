{ channels, ... }:

final: prev: {

  vivaldi = (
    prev.vivaldi.overrideAttrs (oldAttrs: rec {
      version = "6.10.3491.4";

      src = prev.fetchurl {
        url = "https://downloads.vivaldi.com/snapshot/vivaldi-snapshot_${version}-1_amd64.deb";
        hash = "sha256-jbDLdcyjwrsvmSM1MbPSeGMtcewiSDDKzN4nVYo/V/U=";
      };
    })
  );
}
