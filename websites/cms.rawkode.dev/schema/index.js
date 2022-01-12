import createSchema from "part:@sanity/base/schema-creator";
import schemaTypes from "all:part:@sanity/base/schema-type";
import {
  MdOutlineArticle,
  MdOutlineCategory,
  MdOutlineSportsBaseball,
} from "react-icons/md";
import { SiKubernetes } from "react-icons/si";

import blockContent from "./blockContent";
import YouTube from "./youtube";
import Person from "./person";
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
          name: "products",
          title: "Products",
          type: "array",
          of: [{ type: "reference", to: { type: "product" } }],
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
    {
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
        {
          name: "description",
          title: "Description",
          type: "text",
        },
        {
          name: "website",
          title: "Website",
          type: "url",
        },
        {
          name: "repository",
          title: "Repository",
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
      ],
    },
    {
      name: "product",
      title: "Products",
      icon: SiKubernetes,
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
          to: { type: "product" },
        },
      ],
    },
    Person,
    Show,
    Episode,
  ]),
});
