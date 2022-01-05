import { InfluxDB, Point } from "@influxdata/influxdb-client";

// type EventPayload = {
//   readonly n: string;
//   readonly u: Location['href'];
//   readonly d: Location['hostname'];
//   readonly r: Document['referrer'] | null;
//   readonly w: Window['innerWidth'];
//   readonly h: 1 | 0;
//   readonly p?: string;
// };

export default async function handler(req, res) {
  const payload = JSON.parse(req.body);
  console.log(`Payload: ${payload}`);

  const influxDB = new InfluxDB({
    url: process.env.INFLUXDB_URL,
    token: process.env.INFLUXDB_TOKEN,
  });

  const writeApi = influxDB.getWriteApi(
    process.env.INFLUXDB_ORG,
    "website-analytics",
    "us",
    {
      batchSize: 1,
      flushInterval: 50,
      maxRetryTime: 500,
    }
  );

  const path = payload.u
    .replace("http://", "")
    .replace("https://", "")
    .replace(payload.d, "");

  const event = new Point(payload.n)
    .tag("path", path)
    .tag("domain", payload.d)
    .floatField("value", 1);

  if (payload.r) {
    event.tag("referrer", payload.r);
  }

  console.log(`Point: ${event}`);
  writeApi.writePoint(event);

  await writeApi.flush();
  await writeApi.close();

  res.statusCode = 204;
  res.end();
}
