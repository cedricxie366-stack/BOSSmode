// Host identity is selected by this installed entry, never a model tool argument.
process.env.BUILDER_MODE_HOST = 'dsh';
const { startStdioServer } = await import('../builder-mode/mcp/server.mjs');
startStdioServer();
