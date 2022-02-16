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
    {
      name: "slug",
      title: "Slug",
      type: "slug",
      options: {
        source: "name",
        maxLength: 96,
      },
    },
    {
      name: "description",
      title: "Description",
      type: "blockContent",
    },
    {
      name: "url",
      title: "Url",
      type: "url",
    },
    {
      name: "hashtag",
      title: "Hashtag",
      type: "string",
    },
    {
      name: "playlistID",
      title: "Playlist Identifier",
      placeholder:
        "This will be created and saved for you when you create a new show",
      type: "string",
    },
  ],
};
