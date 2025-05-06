# Needed until a new release is made featuring:
## https://github.com/wezterm/wezterm/pull/6508
self: super: {
   wezterm = super.wezterm.overrideAttrs (_: prev: {
     patches = prev.patches or [] ++ [
       (self.fetchpatch {
         url = "https://patch-diff.githubusercontent.com/raw/wez/wezterm/pull/6508.patch";
         sha256 = "sha256-eMpg206tUw8m0Sz+3Ox7HQnejPsWp0VHVw169/Rt4do=";
       }).outPath
     ];
   });
 }
