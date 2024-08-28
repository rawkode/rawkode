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
        monospace = [ "Monaspace Argon" ];
        sansSerif = [ "Monaspace Argon" ];
        serif = [ "Monaspace Argon" ];
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
      (nerdfonts.override {
        fonts = [
          "Monaspace"
          "NerdFontsSymbolsOnly"
        ];
      })
      noto-fonts
      noto-fonts-cjk
      noto-fonts-emoji
      quicksand
      roboto
    ];
  };
}
