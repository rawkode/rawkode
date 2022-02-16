import { MdOutlineArticle } from "react-icons/md";

export const Article = {
  name: "article",
  title: "Articles",
  icon: MdOutlineArticle,
  type: "document",
  fields: [
    {
      name: "title",
      title: "Title",
      type: "string",
    },
    {
      name: "slug",
      title: "Slug",
      type: "slug",
      options: {
        source: "title",
        maxLength: 96,
      },
    },
    {
      name: "publishedAt",
      title: "Published At",
      type: "datetime",
    },
    {
      name: "categories",
      title: "Categories",
      type: "reference",
      to: { type: "category" },
    },
    {
      name: "series",
      title: "Series",
      type: "reference",
      to: { type: "series" },
    },
    {
      name: "technologies",
      title: "Technologies",
      type: "array",
      of: [{ type: "reference", to: { type: "technology" } }],
    },
    {
      name: "body",
      title: "Body",
      type: "blockContent",
    },
  ],

  preview: {
    select: {
      title: "title",
      publishedAt: "publishedAt",
    },
    prepare(selection) {
      const { publishedAt } = selection;
      return Object.assign({}, selection, {
        subtitle: `Published at ${publishedAt}`,
      });
    },
  },
};
