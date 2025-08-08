{ ... }:
final: prev: {
  _1password-gui-beta = prev._1password-gui.overrideAttrs (oldAttrs: rec {
    version = "8.11.6-25.BETA";
    src =
      if prev.stdenv.hostPlatform.system == "x86_64-linux" then
        prev.fetchurl
          {
            url = "https://downloads.1password.com/linux/tar/beta/x86_64/1password-${version}.x64.tar.gz";
            hash = "sha256-gOq2Yl4HmwrmV41iwPQ1jFEHUv6TydTBHLGecgiiRxE=";
          }
      else
        prev.fetchurl {
          url = "https://downloads.1password.com/linux/tar/beta/aarch64/1password-${version}.arm64.tar.gz";
          hash = "sha256-fRgTfZjQRrPbYUKIub+y9iYSBvsElN90ag0maPKTM2g=";
        };
  });
}
