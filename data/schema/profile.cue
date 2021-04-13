{
	_schema: {
		name:      "Profile"
		namespace: "cueblox.rawkode.dev"
	}

	#Profile: {
		_dataset: {
			plural: "profiles"
			supportedExtensions: ["yaml", "yml", "md", "mdx"]
		}

		forename: string @template("Forename")
		surname:  string @template("Surname")
		age?:     int
		company?: string
		title?:   string
		body?:    string
		social_accounts?: [...#TwitterAccount | #GitHubAccount | #MiscellaneousAccount]
	}

	#TwitterAccount: {
		network:  "twitter"
		username: string
		url:      *"https://twitter.com/\(username)" | string
	}

	#GitHubAccount: {
		network:  "github"
		username: string
		url:      *"https://github.com/\(username)" | string
	}

	#MiscellaneousAccount: {
		network: string
		url:     string
	}

	#Website: {
		_dataset: {
			plural: "websites"
			supportedExtensions: ["yaml", "yml"]
		}

		url:         string @template("https://rawkode.dev")
		profile_id?: string
		body?:       string
	}
}
