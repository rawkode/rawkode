import { MdOutlineSportsBaseball } from "react-icons/md";

export const Series = {
  name: "series",
  title: "Series",
  icon: MdOutlineSportsBaseball,
  type: "document",
  fields: [
    {
      name: "title",
      title: "Title",
      type: "string",
    },
    {
      name: "description",
      title: "Description",
      type: "text",
    },
    {
      name: "content",
      type: "reference",
      title: "Content",
      to: [{ type: "article" }, { type: "episode" }],
    },
  ],
};
