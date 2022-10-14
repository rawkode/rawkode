import { ManagedZone } from "../domains";

export const profundum = new ManagedZone("profundum-co-uk", {
  domain: "profundum.co.uk",
  description: "Managed by Pulumi",
}).enableGSuite();
