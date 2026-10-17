import { app } from '../../../lib/app.mjs';

export function GET(req: Request) { return app().search(req); }
export function POST(req: Request) { return app().search(req); }
