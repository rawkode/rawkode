import "ace-builds/src-noconflict/mode-elixir";
import "ace-builds/src-noconflict/mode-nix";
import "ace-builds/src-noconflict/mode-rust";
import "ace-builds/src-noconflict/mode-toml";

export const BlockContent = {
  title: "Block Content",
  name: "blockContent",
  type: "array",
  of: [
    {
      title: "Block",
      type: "block",
      styles: [
        { title: "Normal", value: "normal" },
        { title: "H2", value: "h2" },
        { title: "H3", value: "h3" },
        { title: "H4", value: "h4" },
        { title: "H5", value: "h5" },
        { title: "Quote", value: "blockquote" },
      ],
      lists: [
        { title: "Bullet", value: "bullet" },
        { title: "Numbered", value: "number" },
      ],
      marks: {
        decorators: [
          { title: "Strong", value: "strong" },
          { title: "Emphasis", value: "em" },
          { title: "Code", value: "code" },
          { title: "Underline", value: "underline" },
          { title: "Strike", value: "strike-through" },
        ],
        annotations: [
          {
            title: "URL",
            name: "link",
            type: "object",
            fields: [
              {
                title: "URL",
                name: "href",
                type: "url",
                validation: (Rule) =>
                  Rule.uri({
                    allowRelative: true,
                  }),
              },
            ],
          },
        ],
      },
    },
    {
      type: "image",
      options: { hotspot: true },
    },
    {
      type: "code",
      withFilename: true,
      options: {
        languageAlternatives: [
          { title: "C#", value: "csharp" },
          { title: "CSS", value: "css" },
          { title: "Go", value: "golang" },
          { title: "GROQ", value: "groq" },
          { title: "HTML", value: "html" },
          { title: "Java", value: "java" },
          { title: "JavaScript", value: "javascript" },
          { title: "JSON", value: "json" },
          { title: "Elixir", value: "elixir", mode: "elixir" },
          { title: "JSX", value: "jsx" },
          { title: "Markdown", value: "markdown" },
          { title: "MySQL", value: "mysql" },
          { title: "Nix", value: "nix", mode: "nix" },
          { title: "PHP", value: "php" },
          { title: "Plain text", value: "text" },
          { title: "Python", value: "python" },
          { title: "Ruby", value: "ruby" },
          { title: "Rust", value: "rust", mode: "rust" },
          { title: "SASS", value: "sass" },
          { title: "SCSS", value: "scss" },
          { title: "sh", value: "sh" },
          { title: "TOML", value: "toml", mode: "toml" },
          { title: "TSX", value: "tsx" },
          { title: "TypeScript", value: "typescript" },
          { title: "YAML", value: "yaml" },
        ],
      },
    },
    {
      type: "youtube",
    },
  ],
};
