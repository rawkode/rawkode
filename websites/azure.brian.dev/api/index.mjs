import express from 'express';
import fetch from 'sync-fetch';
import jsonGraphqlExpress from 'json-graphql-server';

const data = fetch('https://github.com/bketelsen/bkml/releases/download/blox/data.json').json();
const app = express();

// https://github.com/marmelab/json-graphql-server/issues/54
app.use('/', jsonGraphqlExpress.default(data));

const port = process.env.FUNCTIONS_CUSTOMHANDLER_PORT;

export default app.listen(port, () => console.log(`Server running on ${port}, http://localhost:${port}`));
