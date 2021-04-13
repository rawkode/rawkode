const fetch = require("sync-fetch");

const jsonServer = require('json-server')

const data = fetch(
  "https://github.com/bketelsen/bkml/releases/download/blox/data.json"
).json();
const app = require("express")();
const router = jsonServer.router(data);

app.use("/", router);
console.log(data);

const port = process.env.PORT || 3000;

module.exports = app.listen(port, () =>
  console.log(`Server running on ${port}, http://localhost:${port}`)
);
