import { clerkMiddleware } from "@clerk/nextjs/server";

// Page- and action-level checks (via auth() in server actions / page components)
// are the source of truth for authorization. The Vapi webhook is the only API
// route open to the public internet — it authenticates via X-Vapi-Secret
// instead of a Clerk session (see app/api/vapi/search-book/route.ts).
export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
