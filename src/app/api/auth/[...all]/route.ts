import { getAuth } from "@/lib/auth/auth";
import { logger } from "@/lib/logger";

// Better Auth handles expected API errors and redirects. Log unexpected
// errors here so the router never prints raw adapter errors to the console.
async function handleAuth(request: Request): Promise<Response> {
  try {
    return await getAuth().handler(request);
  } catch (error) {
    logger.error({ component: "auth", err: error }, "Authentication request failed");
    return new Response(null, { status: 500 });
  }
}

export { handleAuth as GET, handleAuth as POST };
