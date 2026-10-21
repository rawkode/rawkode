{
  perSystem =
    { pkgs, lib, ... }:
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
            autoPatchelfHook
            wrapGAppsHook3
          ];
          buildInputs = with pkgs; [
            gtk3
            libepoxy
            libx11
            libxtst
            libxrandr
            wayland
            fontconfig
          ];
          # Wox loads layer-shell and audio backends dynamically.
          runtimeDependencies = with pkgs; [
            gtk-layer-shell
            alsa-lib
            libpulseaudio
          ];

          unpackPhase = ''
            runHook preUnpack
            dpkg-deb -x "$src" .
            runHook postUnpack
          '';
          dontConfigure = true;
          dontBuild = true;
          # The Go executable embeds application assets.
          dontStrip = true;

          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -r usr/bin usr/share "$out/"
            substituteInPlace "$out/share/applications/io.github.WoxLauncher.Wox.desktop" \
              --replace-fail 'Exec=wox %U' "Exec=$out/bin/wox %U"
            runHook postInstall
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
