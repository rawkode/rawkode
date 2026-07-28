{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "mole";

  darwin.home =
    { pkgs, ... }:
    let
      mole = pkgs.buildGoModule rec {
        pname = "mole";
        version = "1.48.1";

        src = pkgs.fetchurl {
          url = "https://github.com/tw93/Mole/archive/refs/tags/V${version}.tar.gz";
          hash = "sha256-N03NyYHQWBzfUAcxH7W/TP4yatX+Knc1/8RKP3yRsEk=";
        };

        vendorHash = "sha256-hLFlAy4AE1eNOxd4d75Mbo3ZKlwvNK7QV2DNVPd7NHc=";

        nativeBuildInputs = [ pkgs.makeWrapper ];

        buildPhase = ''
          runHook preBuild

          go build -ldflags="-s -w -X main.Version=${version}" -o bin/analyze-go ./cmd/analyze
          go build -ldflags="-s -w -X main.Version=${version}" -o bin/status-go ./cmd/status

          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/bin $out/libexec/mole
          cp -R bin lib $out/libexec/mole/
          install -m755 mole $out/libexec/mole/mole
          makeWrapper $out/libexec/mole/mole $out/bin/mole
          ln -s mole $out/bin/mo

          runHook postInstall
        '';

        doInstallCheck = true;
        installCheckPhase = ''
          $out/bin/mole --version | grep -F ${version}
        '';

        meta = {
          description = "Deep clean and optimize your Mac";
          homepage = "https://mole.fit";
          license = lib.licenses.gpl3Plus;
          platforms = lib.platforms.darwin;
          mainProgram = "mole";
        };
      };
    in
    {
      home.packages = [ mole ];
    };
}
