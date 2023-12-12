{ pkgs }:

{
  program.gh = {
    enable = true;

    gitCredentialHelper = {
      enable = true;
      hosts = [ "https://github.com" ];
    };

    settings = {
      editor = "code --wait";
      git_protocol = "ssh";
      prompt = "enabled";
    };
  };

}
