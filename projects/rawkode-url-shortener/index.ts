import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import * as fs from "fs";

const linkZoneNames = ["rawkode.link"];

const linkZones = linkZoneNames.map((zone) => {
  return new cloudflare.Zone(zone, {
    zone,
    plan: "free",
  });
});

const worker = new cloudflare.WorkerScript(
  "links",
  {
    name: "links",
    content: fs.readFileSync("worker.js").toString(),
  },
  {
    deleteBeforeReplace: true,
  }
);

linkZones.forEach((zone) => {
  zone.zone.apply((zoneName) => {
    new cloudflare.Record(
      zoneName,
      {
        zoneId: zone.id,
        name: "@",
        type: "CNAME",
        value: "rawkode.com",
        proxied: true,
      },
      {
        deleteBeforeReplace: true,
      }
    );

    new cloudflare.WorkerRoute(
      zoneName,
      {
        zoneId: zone.id,
        pattern: pulumi.interpolate`${zone.zone}/*`,
        scriptName: worker.name,
      },
      { dependsOn: [worker] }
    );
  });
});
