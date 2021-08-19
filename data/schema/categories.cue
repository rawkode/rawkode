{
	_schema: {
		name:      "Categories"
		namespace: "cueblox.rawkode.dev"
	}

	#Category: {
		_dataset: {
			plural: "categories"
			supportedExtensions: ["yaml", "yml", "md", "mdx"]
		}

		name:         string @template("Science Fiction")
		parent_id?:   string @relationsip(Category)
	}
}
