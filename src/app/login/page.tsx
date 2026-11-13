import { LogIn } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signInAction } from "@/app/actions";
import { Logo } from "@/components/logo";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { NO_ACCESS_ERROR_CODE } from "@/lib/auth/access";
import { hasSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/config";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  if (error === NO_ACCESS_ERROR_CODE) redirect("/no-access");
  if (await hasSession()) redirect("/");
  const provider = getAuthConfig().OIDC_PROVIDER_NAME;

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center gap-2 text-center">
          <Logo className="mb-2 size-12" />
          <h1 className="text-xl font-semibold tracking-tight">Meldgrove Library</h1>
          <CardDescription>Studies, reports, and articles your colleagues found useful, each with a checked summary.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Sign-in failed</AlertTitle>
              <AlertDescription>Please try again. If it keeps failing, contact your administrator.</AlertDescription>
            </Alert>
          ) : null}
          <form action={signInAction}>
            <Button type="submit" size="lg" className="w-full">
              <LogIn aria-hidden="true" />
              {provider ? `Sign in with ${provider}` : "Sign in"}
            </Button>
          </form>
          <p className="text-center text-xs text-muted-foreground">Use the account of your organization.</p>
        </CardContent>
      </Card>
    </main>
  );
}
