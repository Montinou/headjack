import { app } from '../../../../lib/app.mjs';

// The handler reads the slug from req.url (lib/handlers.mjs slugFromPath), like the v1 function did.
export function GET(req: Request) { return app().getSkill(req); }
