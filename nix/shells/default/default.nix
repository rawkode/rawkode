{ pkgs, ... }:
pkgs.devshell.mkShell {
  name = "initech";
  motd = ''
    {214}⮺  Is it good for the company? ⮺{reset}
    $(type -p menu &>/dev/null && menu)
  '';
}
