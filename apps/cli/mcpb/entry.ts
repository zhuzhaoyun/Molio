/** MCPB 入口：`molio mcp` 的 stdio server，打成单文件后由 Claude Desktop 等客户端拉起。 */
import { runMcpServer } from '../src/mcp/server.js';

process.exitCode = await runMcpServer();