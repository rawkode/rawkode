# Custom library functions - Dendritic pattern
{ inputs, ... }:
{
  flake.lib = {
    __functor = self: super: {
      rawkOS = {
        fileAsSeparatedString =
          path:
          inputs.nixpkgs.lib.strings.concatStringsSep "\n" (
            inputs.nixpkgs.lib.strings.splitString "\n" (builtins.readFile path)
          );
      };
    };
  };
}
