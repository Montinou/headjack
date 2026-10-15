import { mcpApp } from '../../lib/mcp/app.mjs';

export const runtime = 'nodejs';
export function POST(req: Request) { return mcpApp().post(req); }
export function OPTIONS(req: Request) { return mcpApp().options(req); }
export function GET(req: Request) { return mcpApp().unsupported(req); }
export function HEAD(req: Request) { return mcpApp().unsupported(req); }
export function DELETE(req: Request) { return mcpApp().unsupported(req); }
export function PUT(req: Request) { return mcpApp().unsupported(req); }
export function PATCH(req: Request) { return mcpApp().unsupported(req); }
