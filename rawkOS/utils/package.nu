#!/usr/bin/env nu
export def "repo key import" [keyUrl: string] {
	do -c {
		rpm --import $keyUrl
	}
}

export def "repo add" [--name: string, --url: string, --keyUrl: string] {
	do -c {
		{
			$name: {
				name: $name,
				baseurl: $url,
				enabled: 1,
				gpgcheck: 1,
				type: "rpm",
				repo_gpgcheck: 1,
				gpgkey: $keyUrl,
			}
		} | to toml
			|  save $"/etc/yum.repos.d/($name).repo"
	}
}

export def "install" [...packages: string] {
  do -c {
		echo rpm-ostree install $packages
	}
}
