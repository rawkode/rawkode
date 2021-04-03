#!/bin/bash

drb build && json-graphql-server  db.js --p 4000
