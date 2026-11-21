'use strict';
// Kleiner MCP-Server für die Tests (stdio): Werkzeuge „echo“ (nur lesen) und „notiz_anlegen“ (schreibt).
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'test-echo', version: '1.0.0' });
server.registerTool('echo', { description: 'Gibt den Text zurück', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: 'text', text: 'Echo: ' + text + (process.env.FA_TEST_SUFFIX || '') }] }));
server.registerTool('notiz_anlegen', { description: 'Legt eine Notiz an', inputSchema: { titel: z.string() } },
  async ({ titel }) => ({ content: [{ type: 'text', text: 'Notiz angelegt: ' + titel }] }));
server.connect(new StdioServerTransport());
