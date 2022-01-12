import { MdTv } from "react-icons/md";

export const Show = {
  name: "show",
  title: "Show",
  icon: MdTv,
  type: "document",
  fields: [
    {
      name: "name",
      title: "Name",
      type: "string",
    },
  ],
};

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
  ],
};
