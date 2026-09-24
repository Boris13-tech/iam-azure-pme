const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      results.push(file);
    }
  });
  return results;
}

const files = walk('app/api');
const reqs = new Set();
files.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  const regex = /checkPermission\(auth, \{ action: ["'](.*?)["'], resource: ["'](.*?)["'] \}\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    reqs.add(`${match[2]}.${match[1]}`);
  }
});
console.log(Array.from(reqs).join(', '));
