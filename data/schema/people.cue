{
	_schema: {
		name:      "Person"
		namespace: "cueblox.rawkode.dev"
	}

	#Person: {
		_dataset: {
			plural: "people"
			supportedExtensions: ["yaml", "yml", "md", "mdx"]
		}

    email:    string
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
}
