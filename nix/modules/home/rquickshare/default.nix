{ pkgs, ... }:
{
  home.packages = (with pkgs; [ rquickshare ]);
  home.file.".local/share/dev.mandre.rquickshare/.settings.json" = {
    text = ''
      {
        "autostart":true,
        "realclose":false,
        "port": 39706,
        "visibility":0
      }
    '';
  };
}
