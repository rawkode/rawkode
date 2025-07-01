{ config, lib, pkgs, ... }:
{
  home.packages = with pkgs; [
    rustup
    # Common Rust development tools
    cargo-watch
    cargo-edit
    cargo-outdated
    cargo-audit
    sccache
  ];

  home.sessionVariables = {
    CARGO_HOME = "${config.home.homeDirectory}/.cargo";
    RUSTUP_HOME = "${config.home.homeDirectory}/.rustup";
  };

  home.sessionPath = [
    "${config.home.homeDirectory}/.cargo/bin"
  ];

  programs.fish.interactiveShellInit = lib.mkIf config.programs.fish.enable ''
    fish_add_path $HOME/.cargo/bin
  '';

  programs.nushell.extraConfig = lib.mkIf config.programs.nushell.enable ''
    use std/util "path add"
    
    $env.CARGO_HOME = $nu.home-path | path join ".cargo"
    path add ($env.CARGO_HOME | path join "bin")
  '';
}
