import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import * as fs from "fs";

const linkZoneNames = ["rawkode.link"];

const linkZones = linkZoneNames.map((zone) => {
  const z = new cloudflare.Zone(zone, {
    zone,
    plan: "free",
  });

  new cloudflare.ZoneSettingsOverride(zone, {
    zoneId: z.id,
    settings: {
      alwaysUseHttps: "off",
      automaticHttpsRewrites: "off",
      ssl: "flexible",
      minTlsVersion: "1.2",
    },
  });

  return z;
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
        value: "workers.dev",
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
