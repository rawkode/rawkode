import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";

// const webLinkDomains: string[] = [
//   "rawkode.academy",
//   "rawkode.community",
//   "rawkode.link",
// ];

// const createWebLinkZone = async (domain: string) => {
//   const zone = await cloudflare.getZone({
//     name: domain,
//   });

//   console.log(`Zone ${domain} is ${zone.id}`);

//   const record = new cloudflare.Record(domain, {
//     zoneId: zone.id,
//     name: "@",
//     type: "CNAME",
//     proxied: true,
//     value: "workers.dev",
//     allowOverwrite: true,
//   });

//   const workerRoute = new cloudflare.WorkerRoute(domain, {
//     pattern: pulumi.interpolate`${zone.name}/*`,
//     zoneId: zone.id,
//     scriptName: "web-links",
//   });
// };

// webLinkDomains.forEach((domain) => createWebLinkZone(domain));

// import { CloudflarePubSub } from "./cloudflare-pubsub";
// const pubSub = new CloudflarePubSub("analytics", {
//   accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
//   apiToken: process.env.CLOUDFLARE_API_TOKEN || "",
//   namespace: "rawkode",
//   topic: "web-links-analytics",
// });

// export const namespace = pubSub.namespace;
// export const topic = pubSub.topic;
// export const endpoint = pubSub.endpoint;
// export const username = pubSub.username;
// export const password = pubSub.password;
