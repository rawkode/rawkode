import { MdPeople } from "react-icons/md";
import { Handle as GitHubHandle } from "./github";
import { Handle as TwitterHandle } from "./twitter";

export default {
  name: "person",
  title: "People",
  icon: MdPeople,
  type: "document",
  fields: [
    {
      name: "name",
      title: "Name",
      type: "string",
    },
    {
      name: "email",
      title: "Email Address",
      type: "email",
    },
    {
      name: "twitter",
      title: "Twitter Handle",
      type: "string",
      inputComponent: TwitterHandle,
    },
    {
      name: "github",
      title: "GitHub Handle",
      type: "string",
      inputComponent: GitHubHandle,
    },
    {
      name: "website",
      title: "Website",
      type: "url",
    },
    {
      name: "photo",
      title: "Photo",
      type: "image",
      options: {
        hotspot: true,
      },
    },
  ],
};
