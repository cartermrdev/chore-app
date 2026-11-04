import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { safeNext } from "./auth";
import { HomePage } from "./routes/home";
import { ScanPage } from "./routes/scan";
import { InvitePage, MagicLinkPage, SignInPage } from "./routes/sign-in";

// Code-based routes. Add new routes here.
const rootRoute = createRootRoute({
  component: () => (
    <main>
      <Outlet />
    </main>
  ),
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

// The Tag URL. Its path is a permanent contract (ADR 0001): never change it.
const scanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/nfc/$tagId",
  component: function Scan() {
    const { tagId } = scanRoute.useParams();
    return <ScanPage key={tagId} tagId={tagId} />;
  },
});

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// /sign-in?next=/nfc/abc: after signing in, continue to `next` (a path in this app).
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: (s: Record<string, unknown>) => ({ next: str(s.next) }),
  component: function SignIn() {
    const { next } = signInRoute.useSearch();
    return <SignInPage next={safeNext(next)} />;
  },
});

// The emailed magic link: /sign-in/magic?token=…&next=…
const magicLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in/magic",
  validateSearch: (s: Record<string, unknown>) => ({ token: str(s.token), next: str(s.next) }),
  component: function MagicLink() {
    const { token, next } = magicLinkRoute.useSearch();
    return <MagicLinkPage token={token ?? ""} next={safeNext(next)} />;
  },
});

// An Invite link (also shown as a QR code): /invite/{token}
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: function Invite() {
    const { token } = inviteRoute.useParams();
    return <InvitePage key={token} token={token} />;
  },
});

const routeTree = rootRoute.addChildren([homeRoute, scanRoute, signInRoute, magicLinkRoute, inviteRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
