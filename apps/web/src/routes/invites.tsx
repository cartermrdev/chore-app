import { useMutation } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { api } from "../api";

type CreatedInvite = { path: string; displayName: string; expiresAt: string };

/** Admin-only: invite a new Person by display name. Shows a one-time link and a QR code to open on their phone. */
export function InviteForm({ householdId }: { householdId: string }) {
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"standard" | "admin">("standard");
  const create = useMutation({
    mutationFn: () =>
      api<CreatedInvite>(`/households/${householdId}/invites`, {
        method: "POST",
        body: JSON.stringify({ displayName, role }),
      }),
    onSuccess: () => setDisplayName(""),
  });
  const url = create.data ? `${window.location.origin}${create.data.path}` : null;

  return (
    <section>
      <h2>Invite someone</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Name of the person to invite{" "}
          <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>{" "}
        <label>
          Role{" "}
          <select value={role} onChange={(e) => setRole(e.target.value as "standard" | "admin")}>
            <option value="standard">Standard</option>
            <option value="admin">Admin</option>
          </select>
        </label>{" "}
        <button type="submit" disabled={create.isPending}>
          Create invite
        </button>
      </form>
      {create.isError && <p role="alert">Could not create the invite.</p>}
      {create.data && url && (
        <div>
          <p>
            Open this on {create.data.displayName}'s phone. It works once and expires{" "}
            {new Date(create.data.expiresAt).toLocaleDateString()}.
          </p>
          <code data-testid="invite-url">{url}</code>
          <div>
            <QRCodeSVG value={url} size={192} role="img" aria-label="Invite QR code" />
          </div>
        </div>
      )}
    </section>
  );
}
