#!/usr/bin/env nu
export def "repo key import" [keyUrl: string] {
	print $"Importing repository key ($keyUrl)"
	do -c {
		rpm --import $keyUrl
	}
}

export def "repo add" [--name: string, --url: string, --keyUrl: string] {
	print $"Adding repository ($name)"
	do -c {
		$"
		[($name)]
		name = ($name)
		enabled = 1
		type = rpm
		baseurl = ($url)
		gpgcheck = 1
		repo_gpgcheck = 1
		gpgkey = ($keyUrl)
		" | str replace --multiline --all --regex '^\s*' '' |  save $"/etc/yum.repos.d/($name).repo"
	}
}

export def "install" [...packages: string] {
	print $"Installing packages ($packages | str join ' ')"
  do -c {
		rpm-ostree install ...$packages
	}
}
