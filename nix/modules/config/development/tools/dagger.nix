_: {
  flake.homeModules.development-dagger =
    {
      inputs,
      pkgs,
      ...
    }:
    {
      home.packages = with pkgs; [ inputs.dagger.packages.${pkgs.stdenv.hostPlatform.system}.dagger ];
    };
}
