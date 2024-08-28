{
  lib,
  rustPlatform,
  fetchFromGitHub,
  pkg-config,
  wrapGAppsHook,
  atk,
  cairo,
  gdk-pixbuf,
  glib,
  gtk3,
  pango,
  stdenv,
  darwin,
}:

rustPlatform.buildRustPackage rec {
  pname = "browsers";
  version = "0.5.8";

  src = fetchFromGitHub {
    owner = "Browsers-software";
    repo = "browsers";
    rev = version;
    hash = "sha256-o9vyrHQsZQ3qywA4bviM+W4xx64IZL24VHErMFAEMFE=";
  };

  cargoLock = {
    lockFile = ./Cargo.lock;
    outputHashes = {
      "druid-0.8.3" = "sha256-s9csjZ0ZimOrPnjJpPjrrMdNKAXFfroWHBPeR369Phk=";
      "rolling-file-0.2.0" = "sha256-3xeOSXFVVgeKRE39gtzTURt0OkKScQ4uwtvLl4CE3R4=";
    };
  };

  nativeBuildInputs = [
    pkg-config
    wrapGAppsHook
  ];

  buildInputs =
    [
      atk
      cairo
      gdk-pixbuf
      glib
      gtk3
      pango
    ]
    ++ lib.optionals stdenv.isDarwin [
      darwin.apple_sdk.frameworks.AppKit
      darwin.apple_sdk.frameworks.CoreGraphics
      darwin.apple_sdk.frameworks.CoreText
      darwin.apple_sdk.frameworks.Foundation
    ];

  patches = [ ./max9.patch ];

  postInstall = ''
    mkdir -p $out/share/{applications,icons}
    cp extra/linux/dist/software.Browsers.template.desktop $out/share/applications/software.Browsers.desktop
    substituteInPlace \
        $out/share/applications/software.Browsers.desktop \
        --replace 'Exec=€ExecCommand€' 'Exec=${pname} %u'
    cp -r resources $out
    for size in 16 32 128 256 512; do
      mkdir -p $out/share/icons/hicolor/"$size"x"$size"/apps
      cp resources/icons/"$size"x"$size"/software.Browsers.png $out/share/icons/hicolor/"$size"x"$size"/apps/software.Browsers.png
    done
  '';

  meta = {
    description = "Open the right browser at the right time";
    homepage = "https://github.com/Browsers-software/browsers";
    changelog = "https://github.com/Browsers-software/browsers/blob/${src.rev}/CHANGELOG.md";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [ ravenz46 ];
    mainProgram = "browsers";
  };
}
