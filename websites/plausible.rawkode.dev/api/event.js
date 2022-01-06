import { InfluxDB, Point } from "@influxdata/influxdb-client";
import { subdivision } from "iso-3166-2";
import { createClient } from "nominatim-client";

export default async function handler(req, res) {
  const payload = JSON.parse(req.body);

  const influxDB = new InfluxDB({
    url: process.env.INFLUXDB_URL,
    token: process.env.INFLUXDB_TOKEN,
  });

  const writeApi = influxDB.getWriteApi(
    process.env.INFLUXDB_ORG,
    "website-analytics",
    "us"
  );

  const nominatim = createClient({
    useragent: "Rawkode's Modern Life",
    referer: "https://rawkode.dev",
  });

  const path = payload.u
    .replace("http://", "")
    .replace("https://", "")
    .replace(payload.d, "");

  const event = new Point(payload.n)
    .tag("path", path)
    .tag("domain", payload.d)
    .floatField("value", 1);

  if (req.headers["x-real-ip"]) {
    event.tag("clientIP", req.headers["x-real-ip"]);
  }

  let location = "";

  if (req.headers["x-vercel-ip-city"]) {
    location += req.headers["x-vercel-ip-city"];
    event.tag("clientCity", req.headers["x-vercel-ip-city"]);
  }

  if (req.headers["x-vercel-ip-country-region"]) {
    const regionInfo = subdivision(req.headers["x-vercel-ip-country-region"]);
    location += `, ${regionInfo.name}, ${regionInfo.countryName}`;
    event.tag("clientRegion", regionInfo.name);
    event.tag("clientCountry", regionInfo.countryName);
  } else if (req.headers["x-vercel-ip-country"]) {
    location += `, ${req.headers["x-vercel-ip-country"]}`;
    event.tag("clientCountry", req.headers["x-vercel-ip-country"]);
  }

  if (location != "") {
    console.log(`LatLon lookup for ${location}`);
    const locationResult = (
      await nominatim.search({
        q: location,
        addressdetails: 1,
      })
    ).pop();

    if (locationResult && locationResult.lat && locationResult.lon) {
      event.floatField("clientLat", locationResult.lat);
      event.floatField("clientLon", locationResult.lon);
    }
  }

  if (payload.r) {
    event.tag("referrer", payload.r);
  }

  const additional = JSON.parse(payload.p || "{}");

  switch (payload.n) {
    case "Outbound Link: Click":
      event.tag("url", additional.url);
      break;
  }

  console.log(`Point: ${event}`);
  writeApi.writePoint(event);

  await writeApi.flush();
  await writeApi.close();

  res.statusCode = 204;
  res.end();
}
