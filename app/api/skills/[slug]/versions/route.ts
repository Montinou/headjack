import { app } from '../../../../../lib/app.mjs';

export function GET(req: Request) { return app().versions(req); }
