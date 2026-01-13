{
  flake.homeModules.misc =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        ffmpeg
        nodejs
        prettier
        pulumi
        tldr
        unzip
        vim
        watch
      ];

      programs.fzf.enable = true;
      programs.skim.enable = true;
    };
}
