{
  flake.homeModules.cuenv =
    {
      inputs,
      pkgs,
      ...
    }:
    {
      home.packages = [ inputs.cuenv.packages.${pkgs.stdenv.hostPlatform.system}.default ];
      programs.fish.interactiveShellInit = "cuenv shell init fish | source";
    };
}
