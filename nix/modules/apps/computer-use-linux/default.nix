_:
let
  pname = "computer-use-linux";
  version = "0.7.60";
  homepage = "https://github.com/agent-sh/computer-use-linux";

  targets = {
    x86_64-linux = {
      suffix = "x86_64-unknown-linux-musl";
      hashes = {
        computer-use-linux = "sha256-KvSekz7ZKdfLLV2mRIwG+mBkB3zhZFUYRzHWhbdpdMk=";
        computer-use-linux-cosmic = "sha256-iVQxv0qqMvchCQKe3+WU+Hfv9J9cnLPaPsE/y8bzh/U=";
        computer-use-linux-indicator = "sha256-8VXNUiMPrWAT8KbXADpclB7KOTIs0w/iKCXUSwbUIfA=";
      };
    };
    aarch64-linux = {
      suffix = "aarch64-unknown-linux-musl";
      hashes = {
        computer-use-linux = "sha256-sFeR6EpPSvnsXY8SovyRUhZcUm4DWfGKUJfILOh0PFU=";
        computer-use-linux-cosmic = "sha256-6Y+/x1yZcPMYYrii+g0s+m/luzNCLHvsJwDtqaIVjF4=";
        computer-use-linux-indicator = "sha256-dkedHlTgMGMmRAAKseEeGcB+7PY+w+dbyInSiB5Kr8I=";
      };
    };
  };
in
{
  perSystem =
    { lib, pkgs, ... }:
    let
      system = pkgs.stdenv.hostPlatform.system;
      target = targets.${system};
      binaries = lib.mapAttrs (
        name: hash:
        pkgs.fetchurl {
          url = "${homepage}/releases/download/v${version}/${name}-${target.suffix}";
          inherit hash;
        }
      ) target.hashes;
    in
    {
      packages = lib.optionalAttrs (targets ? ${system}) {
        computer-use-linux = pkgs.stdenvNoCC.mkDerivation {
          inherit pname version;
          dontUnpack = true;
          dontStrip = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall
            ${lib.concatStringsSep "\n" (
              lib.mapAttrsToList (name: binary: ''install -Dm755 ${binary} "$out/bin/${name}"'') binaries
            )}
            runHook postInstall
          '';

          postFixup = ''
            wrapProgram "$out/bin/${pname}" \
              --prefix PATH : ${
                lib.makeBinPath [
                  pkgs.glib
                  pkgs.wtype
                ]
              } \
              --prefix XDG_DATA_DIRS : ${pkgs.glib.getSchemaDataDirPath pkgs.gsettings-desktop-schemas}
          '';

          meta = {
            inherit homepage;
            description = "Linux desktop control over MCP and CLI";
            license = lib.licenses.mit;
            mainProgram = pname;
            platforms = builtins.attrNames targets;
            sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
          };
        };
      };
    };
}
