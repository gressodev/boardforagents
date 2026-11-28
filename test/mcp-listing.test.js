// Catalog listing: GET /mcp as a discovery page (JSON, or HTML in both designs), the install one-liners,
// the env-gated /.well-known proofs, and server.json kept in line with the MCP endpoint.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { call, reset } = require('./helpers');
const { MCP_SERVER, TOOLS } = require('../lib/schema');

const BASE = 'https://localhost';
const ONE_LINER = `claude mcp add --transport http boardforagents ${BASE}/mcp`;
const TOOL_NAMES = TOOLS.map((tool) => tool.name);
const rpc = (method, params) => call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method, ...(params && { params }) } });

beforeEach(() => reset());

test('GET /mcp without SSE is a JSON discovery document', async () => {
  for (const accept of [undefined, 'application/json', '*/*']) {
    const r = await call('GET', '/mcp', { headers: accept ? { accept } : {} });
    assert.equal(r.status, 200, accept);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.match(r.headers.vary, /Accept/);
    const doc = r.json;
    assert.equal(doc.name, 'agent-board');
    assert.equal(doc.title, 'Agent Board');
    assert.equal(doc.version, MCP_SERVER.version);
    assert.equal(doc.transport, 'streamable-http');
    assert.equal(doc.endpoint, `${BASE}/mcp`);
    assert.deepEqual(doc.tools, TOOL_NAMES);
    assert.equal(doc.install.claude_code, ONE_LINER);
    assert.deepEqual(doc.install.cursor.config, { mcpServers: { boardforagents: { url: `${BASE}/mcp` } } });
    assert.deepEqual(doc.install.vscode.config, { servers: { boardforagents: { type: 'http', url: `${BASE}/mcp` } } });
    assert.equal(doc.docs.skill, `${BASE}/skill.md`);
    assert.equal(doc.docs.rules, `${BASE}/rules.md`);
    assert.equal(doc.docs.server_card, `${BASE}/.well-known/mcp.json`);
    assert.equal(doc.authentication.required, false);
  }
  // HEAD answers like GET.
  assert.equal((await call('HEAD', '/mcp')).status, 200);
});

test('GET /mcp lists the same tools as tools/list, with and without verified agents', async () => {
  for (const flag of ['on', null]) {
    reset({ flag });
    const listed = (await rpc('tools/list')).json.result.tools.map((tool) => tool.name);
    assert.deepEqual((await call('GET', '/mcp')).json.tools, listed);
  }
});

test('GET /mcp in a browser is an HTML page in both designs', async () => {
  for (const theme of ['modern', 'classic']) {
    const r = await call('GET', '/mcp', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', cookie: `ab_theme=${theme}` } });
    assert.equal(r.status, 200, theme);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(r.headers.vary, /Cookie/);
    const page = r.text;
    assert.ok(page.includes(`<html lang="en" data-theme="${theme}">`), theme);
    assert.ok(page.includes(theme === 'classic' ? 'href="/style-classic.css"' : 'href="/style.css"'), theme);
    assert.ok(page.includes('<title>MCP server — Agent Board</title>'));
    assert.ok(page.includes(`<link rel="canonical" href="${BASE}/mcp">`));
    assert.ok(page.includes('id="mcp"'), theme);
    assert.ok(page.includes(ONE_LINER), theme);
    assert.ok(page.includes('&quot;mcpServers&quot;'), theme);
    for (const link of ['/skill.md', '/rules.md', '/.well-known/mcp.json', 'https://github.com/gressodev/boardforagents']) {
      assert.ok(page.includes(`href="${link}"`), `${theme}: ${link}`);
    }
    for (const tool of TOOL_NAMES) assert.ok(page.includes(`<code>${tool}</code>`), `${theme}: ${tool}`);
    assert.ok(page.includes('href="/mcp?theme=classic"') && page.includes('href="/mcp?theme=modern"'), theme);
    const footer = page.slice(page.lastIndexOf('<footer'), page.lastIndexOf('</footer>'));
    assert.ok(footer.includes('<a href="/rules">Rules of the board</a>'), theme);
    assert.ok(!/check_site|<domain>/.test(page));
  }
});

test('?theme= on /mcp sets the cookie and comes back to /mcp', async () => {
  const r = await call('GET', '/mcp?theme=classic', { headers: { accept: 'text/html' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/mcp');
  assert.match(r.headers['set-cookie'], /^ab_theme=classic;/);
});

test('GET /mcp asking for an SSE stream, and DELETE /mcp, are still 405', async () => {
  for (const [method, headers] of [['GET', { accept: 'text/event-stream' }], ['GET', { accept: 'text/html, text/event-stream' }], ['DELETE', {}]]) {
    const r = await call(method, '/mcp', { headers });
    assert.equal(r.status, 405, `${method} ${headers.accept}`);
    assert.equal(r.headers.allow, 'GET, HEAD, POST, OPTIONS');
    assert.deepEqual(r.json, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST with a JSON-RPC message' } });
  }
});

test('POST /mcp initialize and tools/list still work', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.status, 200);
  assert.deepEqual(init.json.result.serverInfo, { name: 'agent-board', title: 'Agent Board', version: '1.0.0' });
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  const list = await rpc('tools/list');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.result.tools.map((tool) => tool.name), TOOL_NAMES);
});

test('/.well-known/mcp-registry-auth is 404 until MCP_REGISTRY_AUTH is set, then the exact proof as text', async () => {
  const missing = await call('GET', '/.well-known/mcp-registry-auth');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /^No route for GET \/\.well-known\/mcp-registry-auth/);

  const proof = 'v=MCPv1; k=ed25519; p=dGVzdC1vbmx5LW5vdC1hLXJlYWwta2V5LTAwMDAwMDA=';
  process.env.MCP_REGISTRY_AUTH = `  ${proof}\n`;
  for (const headers of [{ accept: 'text/plain' }, { 'user-agent': 'mcp-registry/1.0' }, { accept: 'text/html' }]) {
    const r = await call('GET', '/.well-known/mcp-registry-auth', { headers });
    assert.equal(r.status, 200, JSON.stringify(headers));
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers.location, undefined);
    assert.equal(r.text, `${proof}\n`);
  }

  process.env.MCP_REGISTRY_AUTH = '   ';
  assert.equal((await call('GET', '/.well-known/mcp-registry-auth')).status, 404);
  process.env.MCP_REGISTRY_AUTH = 'x'.repeat(5000);
  assert.equal((await call('GET', '/.well-known/mcp-registry-auth')).status, 404, 'over 4096 bytes is not served');
});

test('/.well-known/glama.json is 404 until GLAMA_CLAIM holds a claim token or a JSON object', async () => {
  assert.equal((await call('GET', '/.well-known/glama.json')).status, 404);

  process.env.GLAMA_CLAIM = 'glama_claim_test123';
  let r = await call('GET', '/.well-known/glama.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers.location, undefined);
  assert.deepEqual(r.json, { $schema: 'https://glama.ai/mcp/schemas/connector.json', claim: 'glama_claim_test123' });

  process.env.GLAMA_CLAIM = ' {"$schema":"https://glama.ai/mcp/schemas/connector.json","claim":"glama_claim_fromjson"} ';
  r = await call('GET', '/.well-known/glama.json');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { $schema: 'https://glama.ai/mcp/schemas/connector.json', claim: 'glama_claim_fromjson' });

  for (const value of ['someone@example.com', 'sk-not-a-claim', '{not json', '["a"]', '']) {
    process.env.GLAMA_CLAIM = value;
    assert.equal((await call('GET', '/.well-known/glama.json')).status, 404, value);
  }
});

test('skill.md and llms.txt carry the install one-liner without messy continuations', async () => {
  const skill = (await call('GET', '/skill.md')).text;
  assert.ok(skill.includes(ONE_LINER));
  assert.ok(skill.includes('"mcpServers"'));
  assert.ok(skill.includes('No API key is needed to read or to post.'));
  assert.ok(skill.includes('bfak_'));
  assert.ok(!skill.includes('\\\\\n'));
  assert.ok(!/check_site/.test(skill));
  reset({ flag: null });
  const plain = (await call('GET', '/skill.md')).text;
  assert.ok(plain.includes(ONE_LINER));
  assert.ok(!plain.includes('bfak_'), 'no key talk while verified agents are off');
  assert.ok((await call('GET', '/llms.txt')).text.includes(`Install in Claude Code: ${ONE_LINER}`));
});

test('server.json and glama.json at the repository root match the endpoint', () => {
  const root = path.join(__dirname, '..');
  const server = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));
  assert.equal(server.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.equal(server.name, 'com.boardforagents/agent-board');
  assert.equal(server.title, MCP_SERVER.title);
  assert.equal(server.version, MCP_SERVER.version);
  assert.ok(server.description.length <= 100, `description is ${server.description.length} characters`);
  assert.equal(server.packages, undefined);
  assert.deepEqual(server.remotes.map((r) => [r.type, r.url]), [['streamable-http', 'https://boardforagents.com/mcp']]);
  assert.equal(server.remotes[0].headers[0].isRequired, false);
  const glama = JSON.parse(fs.readFileSync(path.join(root, 'glama.json'), 'utf8'));
  assert.deepEqual(glama, { $schema: 'https://glama.ai/mcp/schemas/server.json', maintainers: ['gressodev'] });
});
