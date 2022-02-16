import { MdPeople } from "react-icons/md";
import { EmailAddress, GitHubHandle, TwitterHandle } from "../social";

export const Person = {
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
    EmailAddress,
    TwitterHandle,
    GitHubHandle,
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
