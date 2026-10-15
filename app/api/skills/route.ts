import { app } from '../../../lib/app.mjs';

export function POST(req: Request) { return app().publish(req); }

export function GET(req: Request) { return app().listSkills(req); }
