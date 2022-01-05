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
  const influxDB = new InfluxDB({
    url: process.env.INFLUXBD_URL,
    token: process.env.INFLUXDB_TOKEN,
  });

  const writeApi = influxDB.getWriteApi(
    process.env.INFLUXDB_ORG,
    "website-analytics"
  );

  const event = new Point(req.n)
    .tag("url", req.u)
    .tag("domain", req.d)
    .floatField("value", 1);

  if (req.r) {
    event.tag("referrer", req.r);
  }

  writeApi.writePoint(event);

  writeApi.close().then(() => {
    console.log("WRITE FINISHED");
  });

  res.statusCode = 204;
  res.end();
}

const allowCors = (fn) => async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*.rawkode.dev");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,PATCH,DELETE,POST,PUT"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  return await fn(req, res);
};

module.exports = allowCors(handler);
