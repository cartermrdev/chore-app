// Thin JSON client for the backend API. All requests are same-origin (/api)
// so the HttpOnly session cookie is sent automatically.

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API ${status}`);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export type Me = {
  person: { id: string; displayName: string };
  memberships: {
    role: "admin" | "standard";
    household: { id: string; name: string; timeZone: string };
  }[];
};
