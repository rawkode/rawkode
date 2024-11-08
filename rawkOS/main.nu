#!/usr/bin/env nu
use command-line/direnv
use command-line/github
use desktop/onepassword
use dev/distrobox

def main [] {
  direnv
  distrobox
  github
	onepassword
}
