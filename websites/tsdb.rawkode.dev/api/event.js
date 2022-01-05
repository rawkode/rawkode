import { InfluxDB, Point } from "@influxdata/influxdb-client";

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

  const path = payload.u
    .replace("http://", "")
    .replace("https://", "")
    .replace(payload.d, "");

  const event = new Point(payload.n)
    .tag("path", path)
    .tag("domain", payload.d)
    .floatField("value", 1);

  console.log(`Headers`);
  console.log(req.headers);

  if (req.headers["x-real-ip"]) {
    event.tag("clientIP", req.headers["x-real-ip"]);
  }

  if (req.headers["x-vercel-ip-country"]) {
    event.tag("clientCountry", req.headers["x-vercel-ip-country"]);
  }

  if (req.headers["x-vercel-ip-country-region"]) {
    event.tag("clientRegion", req.headers["x-vercel-ip-country-region"]);
  }

  if (req.headers["x-vercel-ip-city"]) {
    event.tag("clientCity", req.headers["x-vercel-ip-city"]);
  }

  if (payload.w && payload.h) {
    event.tag("screen_width", payload.w).tag("screen_height", payload.h);
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
  console.log("Flushed");

  await writeApi.close();
  console.log("Closed");

  res.statusCode = 204;
  res.end();
}
