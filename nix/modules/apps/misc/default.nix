{
  flake.homeModules.misc =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        ffmpeg
        nodejs
        prettier
        tldr
        unzip
        vim
        watch
      ];

      programs.fzf.enable = true;
      programs.skim.enable = true;
    };
}
