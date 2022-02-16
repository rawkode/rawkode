import createSchema from "part:@sanity/base/schema-creator";
import schemaTypes from "all:part:@sanity/base/schema-type";

import { BlockContent } from "./blockContent";
import { Article } from "./blog";
import { Person } from "./crm";
import { Category, Series } from "./meta";
import { Technology } from "./technology";
import { Show, Episode, YouTube } from "./video-content";

export default createSchema({
  name: "website",
  types: schemaTypes.concat([
    BlockContent,
    YouTube,
    Article,
    Category,
    Series,
    Technology,
    Person,
    Show,
    Episode,
  ]),
});
