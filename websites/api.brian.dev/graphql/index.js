const fetch = require("sync-fetch");

import jsonGraphqlExpress from "json-graphql-server";

const data = fetch(
  "https://github.com/bketelsen/bkml/releases/download/blox/data.json"
).json();
const app = require("express")();

app.use("/", jsonGraphqlExpress(data));
console.log(data);

const port = process.env.PORT || 3000;

module.exports = app.listen(port, () =>
  console.log(`Server running on ${port}, http://localhost:${port}`)
);
