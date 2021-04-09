const fetch = require('sync-fetch');

const jsonGraphqlExpress = require('json-graphql-server').default;


const data = fetch('https://github.com/bketelsen/bkml/releases/download/blox/data.json').json();
const app = require('express')();


app.use('/', jsonGraphqlExpress(data));
console.log(data);

// FUNCTIONS_HTTPWORKER_PORT still works, but guidance is to use FUNCTIONS_CUSTOMHANDLER_PORT
const port = process.env.FUNCTIONS_CUSTOMHANDLER_PORT;

module.exports = app.listen(port, () => console.log(`Server running on ${port}, http://localhost:${port}`));
