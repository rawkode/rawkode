{ inputs, pkgs, ... }:
{
  programs.yazi = {
    enable = true;

    enableFishIntegration = true;
    enableNushellIntegration = true;

    flavors = {
      dark = "${inputs.yazi-flavors}/catppuccin-macchiato.yazi";
      light = "${inputs.yazi-flavors}/catppuccin-frappe.yazi";
    };

    plugins = {
      inherit (pkgs.yaziPlugins)
        chmod
        diff
        duckdb
        full-border
        git
        jump-to-char
        mount
        ouch
        restore
        smart-enter
        smart-filter
        sudo
        toggle-pane
        yatline
        yatline-githead
        yatline-catppuccin
        ;
    };
  };
}
