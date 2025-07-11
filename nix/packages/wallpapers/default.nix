{ stdenvNoCC, ... }:

stdenvNoCC.mkDerivation {
  pname = "wallpapers";
  version = "1.0";

  src = ./.;

  installPhase = ''
    mkdir -p $out
    cp *.png $out/
  '';
}
