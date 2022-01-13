import { SiKubernetes } from "react-icons/si";

export const Technology = {
  name: "technology",
  title: "Technologies",
  icon: SiKubernetes,
  type: "document",
  fields: [
    {
      name: "title",
      title: "Title",
      type: "string",
    },
    // {
    //   name: "category",
    //   title: "Category",
    //   type: "string",
    //   options: {
    //     list: [
    //       { title: "Application", value: "application" },
    //       { title: "Cloud", value: "cloud" },
    //       { title: "Developer Tools", value: "developer-tools" },
    //       { title: "DevOps", value: "devops" },
    //       { title: "Programming Language", value: "programming-language" },
    //     ],
    //   },
    // },
    {
      name: "description",
      title: "Description",
      type: "blockContent",
    },
    {
      name: "website",
      title: "Website",
      type: "url",
    },
    {
      name: "logo",
      title: "Logo",
      type: "image",
      options: {
        hotspot: true,
      },
    },
    {
      name: "superceededBy",
      title: "Superceeded By",
      type: "reference",
      to: { type: "technology" },
    },
    {
      name: "opensource",
      title: "Open Source",
      type: "boolean",
    },
    {
      name: "repository",
      title: "Repository",
      type: "url",
      hidden: ({ document }) => !document?.opensource,
    },
    {
      name: "referral_url",
      title: "Referral URL",
      type: "url",
    },
  ],
};
