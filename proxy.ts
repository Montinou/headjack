import { clerkConfigured } from './lib/clerk-config.mjs';
import { NextResponse, type NextRequest, type NextFetchEvent, type NextMiddleware } from 'next/server';

// Establish browser auth state; every API handler independently verifies identity
// and scopes before opening an owner-scoped RLS transaction.
let browserMiddleware: NextMiddleware;
export default async function proxy(req: NextRequest, event: NextFetchEvent) {
  // These exact resource-server routes own OAuth authentication after their flag gate.
  const { pathname } = req.nextUrl;
  if (pathname === '/mcp' || pathname === '/.well-known/oauth-protected-resource/mcp' || pathname === '/.well-known/oauth-protected-resource/api') {
    return NextResponse.next();
  }
  if (!clerkConfigured(process.env)) return NextResponse.next();
  browserMiddleware ??= (await import('@clerk/nextjs/server')).clerkMiddleware();
  return browserMiddleware(req, event);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
