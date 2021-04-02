import jsonGraphqlExpress from "json-graphql-server";
const app = require("express")();

app.use("/", jsonGraphqlExpress(data));

const port = process.env.PORT || 3000;

module.exports = app.listen(port, () =>
  console.log(`Server running on ${port}, http://localhost:${port}`)
);
