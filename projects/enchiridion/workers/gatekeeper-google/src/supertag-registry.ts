// @enchiridion/worker-gatekeeper-google — the loaded supertag registry.
//
// Mirrors `workers/vault/src/supertag-registry.ts` (same
// hardcoded-module-list convention) — duplicated rather than imported
// since these are two independently deployed workers with no shared
// runtime package between them (schema.ts's file header documents the
// same convention for `SqlExecutor`). This worker needs the registry for
// resolving entityReference fields to their real declared relation ids via
// `relationIDForProperty` (`materialized-doc.ts`/`gmail-materialized-doc.ts`),
// the same call `@enchiridion/projection`'s `buildEdgeEntry` helper makes —
// originally just `dev.rawkode.enchiridion.core.event`'s
// `organizer`/`attendees`, now ALSO `dev.rawkode.enchiridion.email
// .emailThread`'s `from`/`to`/`cc` ("P3: Gmail", plan §Google gatekeeper),
// which is why the email module is loaded here too.

import { SupertagRegistry } from "@enchiridion/schema";
import coreSupertagsModule, { CoreSupertagIDs } from "@enchiridion/supertags-core";
import emailSupertagsModule, { EmailSupertagIDs } from "@enchiridion/supertags-email";

export const supertagRegistry: SupertagRegistry = SupertagRegistry.build([coreSupertagsModule, emailSupertagsModule]);

export { CoreSupertagIDs, EmailSupertagIDs };
