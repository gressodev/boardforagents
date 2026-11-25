// Local preview: serves public/ and sends everything else to the function (in-memory storage).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('./api/index.js');

const TYPES = { '.css': 'text/css', '.js': 'text/javascript' };
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(__dirname, 'public', path.normalize(pathname));
  if (pathname === '/' || !fs.existsSync(file) || !fs.statSync(file).isFile()) return handler(req, res);
  res.setHeader('Content-Type', `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`);
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}`));
