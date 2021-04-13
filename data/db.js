const fs = require('fs');
const path = require('path');


const datafile = path.join(__dirname, ".build", "data.json");


var data = {}

const file = JSON.parse(fs.readFileSync(datafile, 'utf8'));
console.log(file)
data = file;


module.exports = data;
