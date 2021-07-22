import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import * as google from "@pulumi/google-native";

const rootDomain = "rawkode.sh";

const rootZone = cloudflare
  .getZones({
    filter: {
      name: rootDomain,
    },
  })
  .then((z) => {
    if (z.zones.length === 0) {
      throw new Error(`Couldn't find ${rootDomain} zone on Cloudflare.`);
    }

    return z.zones.shift();
  });

export const zone = new google.dns.v1.ManagedZone(
  `${pulumi.getStack()}-${rootDomain}`,
  {
    name: `${rootDomain.replace(".", "")}-${pulumi.getStack()}`,
    dnsName: `${pulumi.getStack()}.${rootDomain}.`,
    project: "rawkode",
    description: `${rootDomain} zone`,
  }
);

const zoneNs = new cloudflare.Record(`${pulumi.getStack()}-${rootDomain}`, {
  name: `${pulumi.getStack()}.${rootDomain}`,
  type: "NS",
  zoneId: pulumi.interpolate`${rootZone.then((z) => z?.id)}`,
  ttl: 300,
  value: zone.nameServers[0],
});
