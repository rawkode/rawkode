{ ... }:
{
  # Move this to home-manager when:
  # https://github.com/nix-community/home-manager/pull/5735
  services = {
    ollama = {
      enable = false;
      acceleration = "rocm";
    };

    open-webui = {
      enable = false;
    };
  };
}
