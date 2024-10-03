{ pkgs, ... }: {
  home.packages = with pkgs; [
    distrobox
  ];
}
