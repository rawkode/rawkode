import { MdTv } from "react-icons/md";

export const Episode = {
  name: "episode",
  title: "Episode",
  icon: MdTv,
  type: "document",
  fields: [
    {
      name: "title",
      title: "Title",
      type: "string",
    },
    {
      name: "show",
      title: "Show",
      type: "reference",
      to: { type: "show" },
    },
    {
      name: "guests",
      title: "Guests",
      type: "array",
      of: [{ type: "reference", to: { type: "person" } }],
    },
  ],
};
