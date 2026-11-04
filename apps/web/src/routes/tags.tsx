import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Chore, type Tag } from "../api";

/**
 * Admin-only: create Tags, point them at a Chore (or none) and copy the URL
 * to write onto a physical NFC tag with a third-party writer app.
 */
export function TagManager({ householdId }: { householdId: string }) {
  const queryClient = useQueryClient();
  const tags = useQuery({
    queryKey: ["tags", householdId],
    queryFn: () => api<{ tags: Tag[] }>(`/households/${householdId}/tags`),
  });
  const chores = useQuery({
    queryKey: ["chores", householdId],
    queryFn: () => api<{ chores: Chore[] }>(`/households/${householdId}/chores`),
  });
  const create = useMutation({
    mutationFn: () => api<Tag>(`/households/${householdId}/tags`, { method: "POST", body: "{}" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tags", householdId] }),
  });

  return (
    <section>
      <h2>Tags</h2>
      <button type="button" disabled={create.isPending} onClick={() => create.mutate()}>
        Create tag
      </button>
      {create.error && <span role="alert"> Could not create the tag.</span>}
      {tags.error && <p role="alert">Could not load tags.</p>}
      <ul>
        {tags.data?.tags.map((tag) => (
          <TagRow key={tag.id} householdId={householdId} tag={tag} chores={chores.data?.chores ?? []} />
        ))}
      </ul>
    </section>
  );
}

function TagRow({ householdId, tag, chores }: { householdId: string; tag: Tag; chores: Chore[] }) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}${tag.path}`;
  const link = useMutation({
    mutationFn: (choreId: string | null) =>
      api<Tag>(`/households/${householdId}/tags/${tag.id}`, { method: "PATCH", body: JSON.stringify({ choreId }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tags", householdId] }),
  });

  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
  };

  return (
    <li>
      <code data-testid="tag-url">{url}</code>{" "}
      <button type="button" onClick={copy}>
        {copied ? "Copied" : "Copy URL"}
      </button>{" "}
      <label>
        Chore{" "}
        <select
          value={tag.chore?.id ?? ""}
          disabled={link.isPending}
          onChange={(e) => link.mutate(e.target.value || null)}
        >
          <option value="">(none)</option>
          {chores.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {link.error && <span role="alert"> Could not link the tag.</span>}
    </li>
  );
}
