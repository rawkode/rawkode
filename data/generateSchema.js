const data = require('./db.js');
const { graphql } = require('graphql');
const { jsonSchemaBuilder } = require('json-graphql-server');

const schema = jsonSchemaBuilder(data);
console.log(schema);
