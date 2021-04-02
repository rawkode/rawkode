import jsonGraphqlExpress from "json-graphql-server";
import fetch from "node-fetch";

var data;
const app = require("express")();

const run = () =>
  fetch("https://github.com/rawkode/rawkode/releases/download/blox/data.json")
    .then((res) => res.json())
    .then((json) => {
      data = json;
      console.log(data);
    })
    .then(() => {
      app.use("/", jsonGraphqlExpress(data));
      const port = process.env.PORT || 3000;
    });

module.exports = run().then(() =>
  app.listen(port, () =>
    console.log(`Server running on ${port}, http://localhost:${port}`)
  )
);
