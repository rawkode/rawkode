{ stdenv, fetchFromGitHub }:
stdenv.mkDerivation {
  pname = "draw-on-gnome";
  version = "1.1";

  src = fetchFromGitHub {
    owner = "daveprowse";
    repo = "Draw-On-Gnome";
    rev = "6adec696d222710160888121224a03eaac771d46";
    sha256 = "sha256-uLe91PQZQIhDWlsUKxpRS3a67PGFGqPVTQtCrWnIfKt=";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/gnome-shell/extensions/
    cp -r -T . $out/share/gnome-shell/extensions/draw-on-gnome@daveprowse.github.io
    runHook postInstall
  '';
}
