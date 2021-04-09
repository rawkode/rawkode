{
	_schema: {
		name:      "Category"
		namespace: "schemas.cueblox.com"
	}

	#Category: {
		_model: {
			plural: "categories"
			supportedExtensions: ["yaml", "yml", "md", "mdx"]
		}

		name:  string
		description: string
    body?: string
	}


}