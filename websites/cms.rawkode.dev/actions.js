import defaultResolve from "part:@sanity/base/document-actions";
import { HelloWorldAction } from "./schema/video-content/actions";

export default function resolveDocumentActions(props) {
  return [...defaultResolve(props), HelloWorldAction];
}
