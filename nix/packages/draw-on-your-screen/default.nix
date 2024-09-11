{
  stdenv,
  fetchFromGitHub,
}:
stdenv.mkDerivation {
  pname = "draw-on-your-screen";
  version = "1.1.0";

  src = fetchFromGitHub {
    owner = "zhrexl";
    repo = "DrawOnYourScreen2";
    rev = "3c4e2efb8080577aafc4178991f3bb2e725dc0ed";
    sha256 = "sha256-uLe91PQZQIhDWlsUKxpRS3a67PGFGqPVTQtCrWnIfKs=";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/gnome-shell/extensions/
    cp -r -T . $out/share/gnome-shell/extensions/draw-on-your-screen2@zhrexl.github.com
    runHook postInstall
  '';
}
