import createSchema from "part:@sanity/base/schema-creator";
import schemaTypes from "all:part:@sanity/base/schema-type";
import {
  MdOutlineArticle,
  MdOutlineCategory,
  MdOutlineSportsBaseball,
} from "react-icons/md";
import { SiKubernetes } from "react-icons/si";

import blockContent from "./blockContent";
import Person from "./person";
import { Technology } from "./technology";
import YouTube from "./youtube";
import { Show, Episode } from "./video-content";

export default createSchema({
  name: "website",
  types: schemaTypes.concat([
    blockContent,
    YouTube,
    {
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
    },
    {
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
    },
    {
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
    },
    Technology,
    Person,
    Show,
    Episode,
  ]),
});
