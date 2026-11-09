_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "vivaldi-snapshot";

  linux.system =
    { pkgs, ... }:
    let
      version = "8.3.4191.23";
      arch =
        {
          aarch64-linux = "arm64";
          x86_64-linux = "amd64";
        }
        .${pkgs.stdenv.hostPlatform.system};

      # nixpkgs only packages the stable channel. The snapshot .deb has the same
      # contents under snapshot-specific names, so rename them to the stable
      # layout the nixpkgs derivation patches and installs. The browser keeps
      # its snapshot identity (profile directory, window class, desktop entry).
      vivaldiSnapshot = pkgs.vivaldi.overrideAttrs (old: {
        pname = "vivaldi-snapshot";
        inherit version;

        src = pkgs.fetchurl {
          url = "https://downloads.vivaldi.com/snapshot/vivaldi-snapshot_${version}-1_${arch}.deb";
          hash =
            {
              aarch64-linux = "sha256-8hZ6bKyYfyRVOoa7UgaYywrKKmTCK0F0vfaNxpL7HX4=";
              x86_64-linux = "sha256-TgR4m4AH28l/tQ1MiJfiUXZ/x6hoBdMOfOB5CcHhN1A=";
            }
            .${pkgs.stdenv.hostPlatform.system};
        };

        postUnpack = (old.postUnpack or "") + ''
          mv opt/vivaldi-snapshot opt/vivaldi
          rm opt/vivaldi/vivaldi
          mv opt/vivaldi/vivaldi-snapshot opt/vivaldi/vivaldi
          substituteInPlace usr/share/applications/vivaldi-snapshot.desktop \
            --replace-fail /usr/bin/vivaldi-snapshot /usr/bin/vivaldi-stable \
            --replace-fail Icon=vivaldi-snapshot Icon=vivaldi
        '';
      });
    in
    {
      environment.systemPackages = [ vivaldiSnapshot ];

      # 1Password only trusts browsers it recognises by process name; the
      # renamed snapshot runs as `vivaldi-bin`. `text` is a lines option, so
      # each browser module appends its own entries. The mode makes this a
      # root-owned file rather than a store symlink, which 1Password refuses
      # to read.
      environment.etc."1password/custom_allowed_browsers" = {
        text = ''
          vivaldi-bin
        '';
        mode = "0755";
      };
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "vivaldi@snapshot" ];
      };
    };
}
