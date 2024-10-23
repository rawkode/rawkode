{ channels, ... }:

final: prev: {

  vivaldi = (
    prev.vivaldi.overrideAttrs (oldAttrs: rec {
      version = "7.0.3495.5";

      src = prev.fetchurl {
        url = "https://downloads.vivaldi.com/snapshot/vivaldi-snapshot_${version}-1_amd64.deb";
        hash = "sha256-Y+weoZWFlnoGXa31bDmVMcXvU5fd6gX7zd7r2VKPZLk=";
      };
    })
  );
}
