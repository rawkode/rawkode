_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "rust";

  common.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      home.packages = with pkgs; [
        rustup
        cargo-watch
        cargo-edit
        # cargo's libsqlite3-sys dependency links the system libsqlite3, which
        # nixpkgs' cargo-outdated package does not list as a build input.
        (cargo-outdated.overrideAttrs (old: {
          buildInputs = (old.buildInputs or [ ]) ++ [ sqlite ];
        }))
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

        $env.CARGO_HOME = $env.HOME | path join ".cargo"
        path add ($env.CARGO_HOME | path join "bin")
      '';
    };
}
