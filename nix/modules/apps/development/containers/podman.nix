_: {
  flake.homeModules.development-podman =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        podman
        podman-compose
      ];

      xdg.configFile."containers/registries.conf.d/gcr.io.conf".text = ''
        unqualified-search-registries = ["mirror.gcr.io"]
      '';

      xdg.configFile."containers/storage.conf".text = ''
        [storage]
          driver = "overlay"
          runroot = "$XDG_RUNTIME_DIR/containers"
          graphroot = "$HOME/.local/share/containers/storage"

        [storage.options]
          ignore_chown_errors = "true"
      '';
    };
}
