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
  const payload = req.body;
  console.log(`Payload: ${payload}`);

  const influxDB = new InfluxDB({
    url: process.env.INFLUXDB_URL,
    token: process.env.INFLUXDB_TOKEN,
  });

  const writeApi = influxDB.getWriteApi(
    process.env.INFLUXDB_ORG,
    "website-analytics"
  );

  const event = new Point(payload.n)
    .tag("url", payload.u)
    .tag("domain", payload.d)
    .floatField("value", 1);

  if (payload.r) {
    event.tag("referrer", payload.r);
  }

  console.log(`Point: ${event}`);

  writeApi.writePoint(event);

  writeApi.close().then(() => {
    console.log("WRITE FINISHED");
  });

  res.statusCode = 204;
  res.end();
}
