import defaultResolve from "part:@sanity/base/document-badges";

import { HelloWorldBadge } from "./schema/video-content/actions";

export default function resolveDocumentBadges(props) {
  return [...defaultResolve(props), HelloWorldBadge];
}
