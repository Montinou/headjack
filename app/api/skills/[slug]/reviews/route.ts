import { app } from '../../../../../lib/app.mjs';

export function GET(req: Request) { return app().reviews(req); }
