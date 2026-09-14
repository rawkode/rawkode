{
  lib,
  stdenv,
  rustPlatform,
  pkg-config,
  dbus,
  udev,
  swift,
  swiftpm,
  apple-sdk_14,
  rcodesign,
  python3,
  gtk4,
  wrapGAppsHook4,
  makeWrapper,
  makeDesktopItem,
}:
let
  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Package.swift
      ../Sources
      ../Resources
      ../platforms/linux/multipass.py
      ../platforms/linux/engine_client.py
      ../platforms/linux/pairing_dialogs.py
    ];
  };
  engine = rustPlatform.buildRustPackage {
    pname = "multipass-engine";
    version = "0.2.0";
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../Cargo.toml
        ../Cargo.lock
        ../crates
      ];
    };
    cargoLock.lockFile = ../Cargo.lock;
    nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ pkg-config ];
    buildInputs =
      lib.optionals stdenv.hostPlatform.isLinux [
        dbus
        udev
      ]
      ++ lib.optionals stdenv.hostPlatform.isDarwin [ apple-sdk_14 ];
    cargoBuildFlags = [
      "--package"
      "multipass-core"
      "--bin"
      "multipass-engine"
    ];
    # Socket/Bonjour and platform permission tests require a real desktop session.
    doCheck = false;
    meta = {
      description = "Shared Multipass Bluetooth handoff engine";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux ++ lib.platforms.darwin;
      mainProgram = "multipass-engine";
    };
  };
  python = python3.withPackages (packages: [ packages.pygobject3 ]);
  desktopItem = makeDesktopItem {
    name = "dev.rawkode.multipass";
    desktopName = "Multipass";
    comment = "Let your mouse follow your keyboard between computers";
    exec = "multipass";
    icon = "input-mouse";
    categories = [ "Utility" ];
    terminal = false;
  };
  multipass = stdenv.mkDerivation {
    pname = "multipass";
    version = "0.2.0";
    src = source;
    nativeBuildInputs = [
      makeWrapper
    ]
    ++ lib.optionals stdenv.hostPlatform.isDarwin [
      swift
      swiftpm
      rcodesign
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [ wrapGAppsHook4 ];
    buildInputs =
      lib.optionals stdenv.hostPlatform.isDarwin [ apple-sdk_14 ]
      ++ lib.optionals stdenv.hostPlatform.isLinux [ gtk4 ];
    dontConfigure = true;
    dontBuild = stdenv.hostPlatform.isLinux;
    dontStrip = stdenv.hostPlatform.isDarwin;
    buildPhase = lib.optionalString stdenv.hostPlatform.isDarwin ''
      runHook preBuild
      swift build --configuration release --disable-sandbox --cache-path "$TMPDIR/swift-cache" \
        --config-path "$TMPDIR/swift-config" --security-path "$TMPDIR/swift-security"
      runHook postBuild
    '';
    installPhase =
      if stdenv.hostPlatform.isDarwin then
        ''
          runHook preInstall
          app="$out/Applications/Multipass.app"
          mkdir -p "$app/Contents/MacOS" "$out/bin"
          cp .build/release/Multipass "$app/Contents/MacOS/Multipass"
          cp ${engine}/bin/multipass-engine "$app/Contents/MacOS/multipass-engine"
          cp Resources/Info.plist "$app/Contents/Info.plist"
          makeWrapper /usr/bin/open "$out/bin/multipass" --add-flags "$app"
          runHook postInstall
        ''
      else
        ''
          runHook preInstall
          mkdir -p "$out/share/multipass" "$out/bin"
          cp platforms/linux/{multipass.py,engine_client.py,pairing_dialogs.py} "$out/share/multipass/"
          makeWrapper ${python}/bin/python3 "$out/bin/multipass" \
            --add-flags "$out/share/multipass/multipass.py" \
            --add-flags "--engine ${engine}/bin/multipass-engine"
          mkdir -p "$out/share/applications"
          cp ${desktopItem}/share/applications/* "$out/share/applications/"
          runHook postInstall
        '';
    postFixup = lib.optionalString stdenv.hostPlatform.isDarwin ''
      rcodesign sign "$out/Applications/Multipass.app"
    '';
    meta = {
      description = "Native keyboard-following mouse switcher";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux ++ lib.platforms.darwin;
      mainProgram = "multipass";
    };
  };
in
{
  inherit engine multipass;
}
