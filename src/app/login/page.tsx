import { Alert, AlertDescription, AlertTitle } from "@meldgrove/ui/alert";
import { Button } from "@meldgrove/ui/button";
import { SignInPage } from "@meldgrove/ui/sign-in-page";
import { LogIn } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signInAction } from "@/app/actions";
import { LogoMark } from "@/components/logo";
import { NO_ACCESS_ERROR_CODE } from "@/lib/auth/access";
import { hasSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/config";
import { REPOSITORY_URL } from "@/lib/repository";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  if (error === NO_ACCESS_ERROR_CODE) redirect("/no-access");
  if (await hasSession()) redirect("/");
  const provider = getAuthConfig().OIDC_PROVIDER_NAME;

  return (
    <SignInPage
      app={{ name: "Meldgrove Library", icon: <LogoMark /> }}
      tagline="Studies, reports, and articles your colleagues found useful, each with a checked summary."
      repositoryUrl={REPOSITORY_URL}
      description="Use the account of your organization."
    >
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
    </SignInPage>
  );
}
