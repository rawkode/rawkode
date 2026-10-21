_:
let
  mkApp = import ../../../lib/mkApp.nix;

  version = "20261021.050521.0-sha.bfde0792";

  # Platform -> SHA-256 of the version-pinned release tarball, from the
  # matching `.sha256` file on artifacts.swamp-club.com.
  sources = {
    x86_64-linux = {
      platform = "linux-x86_64";
      hash = "sha256:0878b3a0ae8f8a8e94f81a05b1a742b228afeabf356b8e6d6e82e1dbbf46e522";
    };
    aarch64-linux = {
      platform = "linux-aarch64";
      hash = "sha256:db85a9c17539b1b21f1b7b09c88168fd30c37757c571e6a6140fb318a6b81092";
    };
    x86_64-darwin = {
      platform = "darwin-x86_64";
      hash = "sha256:06fd29ce0eb99c7ca48fcc86088aa6be0cea696dab4f68b4beda9a0eb8dd6ed9";
    };
    aarch64-darwin = {
      platform = "darwin-aarch64";
      hash = "sha256:898ed58a21eaa1377728f5271aa2c7bc098660a594476336d58c1b16269f870e";
    };
  };

  mkSwamp =
    { lib, pkgs }:
    let
      src = sources.${pkgs.stdenv.hostPlatform.system};
      os = lib.head (lib.splitString "-" src.platform);
      arch = lib.last (lib.splitString "-" src.platform);
    in
    pkgs.stdenv.mkDerivation {
      pname = "swamp";
      inherit version;

      src = pkgs.fetchurl {
        url = "https://artifacts.swamp-club.com/swamp/${version}/binary/${os}/${arch}/swamp-${version}-binary-${src.platform}.tar.gz";
        inherit (src) hash;
      };

      sourceRoot = ".";

      nativeBuildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
      buildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];

      # `deno compile` appends the application payload to the executable;
      # stripping it discards the payload.
      dontStrip = true;

      installPhase = ''
        runHook preInstall
        install -Dm755 swamp $out/bin/swamp
        runHook postInstall
      '';

      meta = {
        description = "Build AI systems from repeatable, behavior-centric components";
        homepage = "https://swamp-club.com";
        license = lib.licenses.unfree;
        mainProgram = "swamp";
        platforms = lib.attrNames sources;
        sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      };
    };
in
mkApp {
  name = "swamp";

  common.home =
    { lib, pkgs, ... }:
    {
      home.packages = [ (mkSwamp { inherit lib pkgs; }) ];
    };
}
