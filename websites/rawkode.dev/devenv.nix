{ pkgs, ... }:
{
  languages.javascript = {
    enable = true;
    bun.enable = true;
  };
  languages.typescript.enable = true;

  packages = with pkgs; [
    libgccjit
    patchelf
  ];

  enterShell = ''
    bun install

    export LD_LIBRARY_PATH=${pkgs.libgccjit}/lib:$LD_LIBRARY_PATH

    __patchTarget="./node_modules/@cloudflare/workerd-linux-64/bin/workerd"
    if [[ -f "$__patchTarget" ]]; then
      ${pkgs.patchelf}/bin/patchelf --set-interpreter ${pkgs.glibc}/lib/ld-linux-x86-64.so.2 "$__patchTarget"
    fi
  '';
}
