{ lib }:
{
  fileAsSeparatedString =
    path: lib.strings.concatStringsSep "\n" (lib.strings.splitString "\n" (builtins.readFile path));
}
