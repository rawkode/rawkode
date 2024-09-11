{ pkgs, ... }:
{
  fonts = {
    enableDefaultPackages = false;

    fontconfig = {
      enable = true;

      antialias = true;
      hinting.enable = true;
      hinting.autohint = true;

      defaultFonts = {
        sansSerif = [ "Lato" ];
        serif = [ "Merriweather" ];
        monospace = [ "Monaspace Argon" ];
        emoji = [ "Noto Color Emoji" ];
      };
    };

    fontDir = {
      enable = true;
    };

    packages = with pkgs; [
      corefonts
      material-symbols
      merriweather
      monaspace
      (nerdfonts.override {
        fonts = [
          "Monaspace"
          "NerdFontsSymbolsOnly"
        ];
      })
      noto-fonts
      noto-fonts-cjk
      noto-fonts-emoji
      poppins
      quicksand
      roboto
    ];
  };
}
