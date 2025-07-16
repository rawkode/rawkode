{ ... }:
final: prev: {
  _1password-gui-beta = prev._1password-gui.overrideAttrs (oldAttrs: {
    version = "8.11.0-25.BETA";
    src =
      if prev.stdenv.isDarwin then
        if prev.stdenv.hostPlatform.system == "x86_64-darwin" then
          prev.fetchurl {
            url = "https://downloads.1password.com/mac/1Password-8.11.0-25.BETA-x86_64.zip";
            hash = "sha256-9cE31VdYoxFnxsO0jOLQsXA2SEBUdy7ABvUIfsGEE04=";
          }
        else
          prev.fetchurl {
            url = "https://downloads.1password.com/mac/1Password-8.11.0-25.BETA-aarch64.zip";
            hash = "sha256-eV6gTKbTWkC1Kg5vyGf4tgiBxOQ5ZOKha03PSTGVE9Q=";
          }
      else if prev.stdenv.hostPlatform.system == "x86_64-linux" then
        prev.fetchurl {
          url = "https://downloads.1password.com/linux/tar/beta/x86_64/1password-8.11.0-25.BETA.x64.tar.gz";
          hash = "sha256-TMVquYVZPxJGxn7vEwhSsD5eebM+9xovdBB/5/y2ygc=";
        }
      else
        prev.fetchurl {
          url = "https://downloads.1password.com/linux/tar/beta/aarch64/1password-8.11.0-25.BETA.arm64.tar.gz";
          hash = "sha256-fRgTfZjQRrPbYUKIub+y9iYSBvsElN90ag0maPKTM2g=";
        };
  });
}
