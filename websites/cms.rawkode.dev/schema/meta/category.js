import { MdOutlineCategory } from "react-icons/md";

export const Category = {
  name: "category",
  title: "Categories",
  icon: MdOutlineCategory,
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
  ],
};
