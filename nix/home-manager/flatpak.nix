{ ... }:
{
  services.flatpak = {
    enable = true;

    update.onActivation = true;
    uninstallUnmanaged = true;

    # remotes = [
    #   {
    #     name = "flathub-beta";
    #     location = "https://flathub.org/beta-repo/flathub-beta.flatpakrepo";
    #   }
    # ];

    packages = [ "io.github.zen_browser.zen" ];
  };
}
