import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { HomePage } from "./routes/home";
import { ScanPage } from "./routes/scan";

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

const routeTree = rootRoute.addChildren([homeRoute, scanRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
