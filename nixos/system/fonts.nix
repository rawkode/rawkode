{ pkgs, ... }:
{
  fonts = {
    enableDefaultPackages = false;

    fontconfig = {
      antialias = true;
      hinting.enable = true;
      hinting.autohint = true;

      defaultFonts = {
        monospace = [ "Monaspace Krypton" ];
        sansSerif = [ "Monaspace Krypton" ];
        serif = [ "Merriweather" ];
      };
    };

    fontDir = {
      enable = true;
    };

    packages = with pkgs; [
      corefonts
      (google-fonts.override { fonts = [ "Inter" ]; })
      material-symbols
      merriweather
      monaspace
      (nerdfonts.override { fonts = [ "NerdFontsSymbolsOnly" ]; })
      noto-fonts
      noto-fonts-cjk
      noto-fonts-emoji
      quicksand
      roboto
    ];
  };
}
