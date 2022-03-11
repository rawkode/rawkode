// If I want to export the domain name zone IDs for a StackReference
import { getController, managedDomains as domains } from "./dns";

export const managedDomains = domains.reduce(
  (zones, domain) =>
    Object.assign(zones, { [domain.domainName]: domain.zone.id }),
  {}
);

const clusterDomain = getController("rawkode.sh");

import { createCluster } from "./cluster/scaleway";
const provider = createCluster({
  name: "rawkode-production",
});

import { create as createPlatform } from "./platform";
const platformDependency = createPlatform({
  provider,
  domainController: clusterDomain,
});

import { Project } from "./platform";

const academyDomain = getController("rawkode.academy");
const academyProject = new Project("academy", {
  rootDomainName: academyDomain.domainName,
  platformDependency,
  provider,
});

export const academyStackName = academyProject.stackName;
