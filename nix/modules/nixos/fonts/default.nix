{ pkgs, ... }: {
  fonts = {
    enableDefaultPackages = false;
    enableGhostscriptFonts = true;

    fontconfig = {
      enable = true;

      antialias = true;
      hinting.enable = true;
      hinting.autohint = true;

      allowBitmaps = true;
      useEmbeddedBitmaps = true;

      defaultFonts = {
        sansSerif = [ "Nato Sans" ];
        serif = [ "Nato" ];
        monospace = [ "Monaspace Neon" ];
        emoji = [ "EmojiOne Color" "Noto Color Emoji" "Noto Emoji" ];
      };
    };

    fontDir.enable = true;

    packages = with pkgs; [
      corefonts
      emojione
      monaspace
      (nerdfonts.override { fonts = [ "Monaspace" "NerdFontsSymbolsOnly" ]; })
      noto-fonts
      noto-fonts-emoji
    ];
  };
}
