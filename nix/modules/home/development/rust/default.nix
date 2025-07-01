{ config, lib, pkgs, ... }:

let
  cfg = config.programs.rust;
in
{
  options.programs.rust = {
    enable = lib.mkEnableOption "Rust programming language";
    
    useRustup = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to use rustup for managing Rust toolchains";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = with pkgs; lib.mkMerge [
      (lib.mkIf cfg.useRustup [ rustup ])
      (lib.mkIf (!cfg.useRustup) [ 
        rustc
        cargo
        clippy
        rustfmt
        rust-analyzer
      ])
      # Common Rust development tools
      [
        cargo-watch
        cargo-edit
        cargo-outdated
        cargo-audit
        sccache
      ]
    ];

    home.sessionVariables = {
      CARGO_HOME = "${config.home.homeDirectory}/.cargo";
      RUSTUP_HOME = "${config.home.homeDirectory}/.rustup";
    };

    home.sessionPath = [
      "${config.home.homeDirectory}/.cargo/bin"
    ];

    # Fish configuration
    programs.fish.interactiveShellInit = lib.mkIf config.programs.fish.enable ''
      fish_add_path $HOME/.cargo/bin
    '';

    # Nushell configuration
    programs.nushell.extraConfig = lib.mkIf config.programs.nushell.enable ''
      use std/util "path add"
      
      $env.CARGO_HOME = $nu.home-path | path join ".cargo"
      path add ($env.CARGO_HOME | path join "bin")
    '';
  };
}