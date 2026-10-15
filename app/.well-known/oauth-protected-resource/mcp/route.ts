import { mcpApp } from '../../../../lib/mcp/app.mjs';

export const runtime = 'nodejs';
export function GET(req: Request) { return mcpApp().metadata(req); }
export function OPTIONS(req: Request) { return mcpApp().options(req); }
