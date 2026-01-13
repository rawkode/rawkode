{
  flake.nixosModules.fonts =
    { pkgs, ... }:
    {
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
            monospace = [ "Monaspace Argon" ];
            emoji = [
              "JoyPixels"
              "EmojiOne Color"
              "Noto Color Emoji"
              "Noto Emoji"
            ];
          };
        };

        fontDir.enable = true;

        packages = with pkgs; [
          corefonts
          emojione
          joypixels
          monaspace
          nerd-fonts.monaspace
          nerd-fonts.symbols-only
          noto-fonts
          noto-fonts-emoji
        ];
      };
    };

}
