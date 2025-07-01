{ pkgs, ... }: {
  home.packages = with pkgs; [
    lazyjournal
  ];
}
