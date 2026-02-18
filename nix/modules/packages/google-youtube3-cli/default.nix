{
  perSystem =
    { lib, pkgs, ... }:
    {
      packages.google-youtube3-cli = pkgs.rustPlatform.buildRustPackage rec {
        pname = "google-youtube3-cli";
        version = "7.0.0+20251222";

        src = pkgs.fetchCrate {
          inherit pname version;
          hash = "sha256-lwPJTOXgfw5Xt7bSgJIdGJ5TmqFpg32D0GBGS/z3dS0=";
        };

        cargoHash = "sha256-ZhCDZiy2/dya1aF6zon38sZBiOl33sG+BswC5hze/IM=";

        doCheck = false;

        meta = with lib; {
          description = "CLI for interacting with the YouTube Data API v3";
          homepage = "https://github.com/Byron/google-apis-rs/tree/main/gen/youtube3-cli";
          license = licenses.mit;
          mainProgram = "youtube3";
        };
      };
    };
}
