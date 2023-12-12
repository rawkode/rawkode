{ pkgs, name, email }:

{
  program.git = {
    enable = true;
    userName = name;
    userEmail = email;
    package = pkgs.gitAndTools.gitFull;

    delta = { enable = true; };

    lfs = { enable = true; };

    ignores = [
      ".cache/"
      ".DS_Store"
      ".direnv/"
      ".idea/"
      "*.swp"
      "built-in-stubs.jar"
      "dumb.rdb"
      ".elixir_ls/"
      ".vscode/"
      "npm-debug.log"
    ];

    aliases = {
      cane = "commit --amend --no-edit";
      co = "checkout";
      fo = "!git reset --hard HEAD && git clean -qfdx";
      st = "status";
    };

    extraConfig = {
      core = {
        editor = "code --wait";
        whitespace = "trailing-space,space-before-tab";
      };

      commit.gpgsign = "true";
      gpg = {
        format = "ssh";
      };

      user = {
        signingKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAXwFFDFPDUbAql+V8xMmFxuZe6aUUxDD2cY0Dr0X1g9";
      };

      init.defaultBranch = "main";
      credential.helper = "osxkeychain";

      branch = {
        autoSetupRebase = "always";
      };

      rerere = {
        enabled = "true";
        autoupdate = "true";
      };

      pull = {
        current = "true";
        rebase = "true";
      };
      push.default = "current";
    };
  };
}
