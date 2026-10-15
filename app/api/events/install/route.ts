import { app } from '../../../../lib/app.mjs';

export function POST(req: Request) { return app().installEvent(req); }
