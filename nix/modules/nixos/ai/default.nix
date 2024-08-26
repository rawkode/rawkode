{ ... }:
{
  # Move this to home-manager when:
  # https://github.com/nix-community/home-manager/pull/5735
  services.ollama = {
    enable = true;
    acceleration = "rocm";
  };
}
