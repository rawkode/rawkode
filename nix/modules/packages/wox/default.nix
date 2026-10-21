{
  perSystem =
    { pkgs, lib, ... }:
    let
      runtimeLibraries = with pkgs; [
        gtk3
        pango
        at-spi2-core
        cairo
        gdk-pixbuf
        glib
        libepoxy
        libx11
        libxtst
        libxrandr
        wayland
        fontconfig
        gtk-layer-shell
        alsa-lib
        libpulseaudio
      ];
    in
    {
      packages = lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") {
        wox = pkgs.stdenv.mkDerivation {
          pname = "wox";
          version = "2.4.7";

          src = pkgs.fetchurl {
            url = "https://github.com/Wox-launcher/Wox/releases/download/v2.4.7/wox-linux-amd64.deb";
            hash = "sha256-Fh0gwOlakEK/sSbnZRxz0cY/kGSM61saiiKucb854Do=";
          };

          nativeBuildInputs = with pkgs; [
            dpkg
            makeWrapper
            wrapGAppsHook3
          ];
          buildInputs = runtimeLibraries;
          # patchelf corrupts this Go executable's ELF program headers. Keep it
          # intact and invoke the Nix loader with explicit library search paths.
          dontPatchELF = true;
          dontWrapGApps = true;

          unpackPhase = ''
            runHook preUnpack
            dpkg-deb -x "$src" .
            runHook postUnpack
          '';
          dontConfigure = true;
          dontBuild = true;
          dontStrip = true;

          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -r usr/share "$out/"
            install -Dm755 usr/bin/wox "$out/libexec/wox"
            substituteInPlace "$out/share/applications/io.github.WoxLauncher.Wox.desktop" \
              --replace-fail 'Exec=wox %U' "Exec=$out/bin/wox %U"
            runHook postInstall
          '';

          preFixup = ''
            makeWrapper "${pkgs.stdenv.cc.bintools.dynamicLinker}" "$out/bin/wox" "''${gappsWrapperArgs[@]}" \
              --add-flags "--library-path ${lib.makeLibraryPath runtimeLibraries} $out/libexec/wox"
          '';

          meta = {
            description = "Native launcher with local search and extensible plugins";
            homepage = "https://github.com/Wox-launcher/Wox";
            license = lib.licenses.gpl3Only;
            mainProgram = "wox";
            platforms = [ "x86_64-linux" ];
            sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
          };
        };
      };
    };
}
