import { convertMCPSchemaToToolSchema } from "./schema.js";

/**
 * @typedef {import("./types.js").ToolConfig} ToolConfig
 */

/**
 * @typedef {object} MCPConnection
 * @property {ToolConfig[]} tools
 * @property {string} name
 * @property {() => Promise<void>} reconnect
 * @property {() => Promise<void>} close
 */

/**
 * @typedef {object} MCPConnectionConfig
 * @property {() => any} transport
 * @property {string} [name]
 * @property {string} [version]
 */

/**
 * @typedef {object} MCPManager
 * @property {(config: MCPConnectionConfig) => Promise<MCPConnection>} connect
 * @property {ToolConfig[]} tools
 * @property {(name?: string) => Promise<void>} reconnect
 * @property {(name?: string) => Promise<void>} close
 */

/**
 * @param {any} client
 * @returns {Promise<ToolConfig[]>}
 */
const buildTools = async (client) => {
  const serverName = client.getServerVersion()?.name;

  if (!serverName) {
    console.error("MCP server has no name, skipping tool creation");
    return [];
  }

  return (await client.listTools()).tools.map((mcpTool) => ({
    name: `${serverName}_${mcpTool.name}`,
    description: `[${serverName}] ${mcpTool.description || ""}`,
    schema: convertMCPSchemaToToolSchema(mcpTool.inputSchema),
    execute: async (args) => {
      const result = await client.callTool({ name: mcpTool.name, arguments: args });
      return (
        (result.content && Array.isArray(result.content) && result.content[0]?.text) ||
        JSON.stringify(result)
      );
    },
  }));
};

/**
 * connect to an MCP server and expose its tools as ToolConfigs
 *
 * @param {MCPConnectionConfig} config
 * @returns {Promise<MCPConnection>}
 */
export const connectMCP = async (config) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const newClient = () =>
    new Client(
      { name: config.name || "prsm-ai", version: config.version || "1.0.0" },
      { capabilities: {} },
    );

  let client = newClient();
  await client.connect(config.transport());
  let tools = await buildTools(client);
  const serverName = client.getServerVersion()?.name || config.name || "unknown";

  return {
    get tools() {
      return tools;
    },
    name: serverName,
    async reconnect() {
      await client.close();
      client = newClient();
      await client.connect(config.transport());
      tools = await buildTools(client);
    },
    async close() {
      await client.close();
      tools = [];
    },
  };
};

/**
 * manage multiple named MCP connections and aggregate their tools
 *
 * @returns {MCPManager}
 */
export const createMCPManager = () => {
  /** @type {Map<string, { connection: MCPConnection, config: MCPConnectionConfig }>} */
  const connections = new Map();

  return {
    async connect(config) {
      const connection = await connectMCP(config);
      connections.set(connection.name, { connection, config });
      return connection;
    },

    get tools() {
      return Array.from(connections.values()).flatMap(({ connection }) => connection.tools);
    },

    async reconnect(name) {
      if (name) {
        const entry = connections.get(name);
        if (!entry) throw new Error(`MCP connection "${name}" not found`);
        await entry.connection.reconnect();
        return;
      }
      await Promise.all(
        Array.from(connections.values()).map(({ connection }) => connection.reconnect()),
      );
    },

    async close(name) {
      if (name) {
        const entry = connections.get(name);
        if (!entry) throw new Error(`MCP connection "${name}" not found`);
        await entry.connection.close();
        connections.delete(name);
        return;
      }
      await Promise.all(
        Array.from(connections.values()).map(({ connection }) => connection.close()),
      );
      connections.clear();
    },
  };
};
