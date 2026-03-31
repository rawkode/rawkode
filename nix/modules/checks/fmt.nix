{
  perSystem =
    { pkgs, ... }:
    {
      treefmt = {
        projectRootFile = "flake.nix";

        programs = {
          nixfmt = {
            enable = true;
            package = pkgs.nixfmt;
          };
          shellcheck.enable = true;
          shfmt = {
            enable = true;
            indent_size = null; # respect .editorconfig
          };
          statix.enable = true;
          deadnix.enable = true;
          taplo.enable = true;
        };

        # Keep JS/TS/JSON formatting on the checked-in Biome v2 config so
        # editors and `nix fmt` follow the same rules.
        settings.formatter.biome = {
          command = "${pkgs.lib.getExe pkgs.biome}";
          options = [
            "format"
            "--write"
            "--no-errors-on-unmatched"
            "--config-path"
            "./biome.json"
          ];
          includes = [
            "*.cjs"
            "*.css"
            "*.cts"
            "*.graphql"
            "*.html"
            "*.js"
            "*.json"
            "*.jsonc"
            "*.jsx"
            "*.md"
            "*.mjs"
            "*.mts"
            "*.ts"
            "*.tsx"
          ];
          excludes = [ ".claude/**" ];
        };
      };
    };
}
