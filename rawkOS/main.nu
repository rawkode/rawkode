#!/usr/bin/env nu
use command-line/direnv
use command-line/github
use desktop/onepassword

def main [] {
  direnv
  github
	onepassword
}
