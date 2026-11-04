/**
 * Tag service. A Tag belongs to one Household and points at zero or one
 * Chore. Its id is the {tagId} of the permanent URL /nfc/{tagId} (ADR 0001):
 * random, unguessable and URL-safe.
 */
import type { Clock } from "../clock";
import type { Db } from "../db/client";

/** 144 random bits, which encode to exactly 24 base64url characters. */
const TAG_ID_BYTES = 18;

export function newTagId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(TAG_ID_BYTES))).toString("base64url");
}

/**
 * Whether a string could be a Tag ID: URL-safe (base64url alphabet) and long
 * enough to carry at least 128 bits. Generated IDs are 24 characters; IDs
 * written onto Tags by other means (an Unregistered Tag) may be up to 64.
 * Distinguishes an Unregistered Tag (well-formed, never seen) from garbage.
 */
export function isWellFormedTagId(tagId: string): boolean {
  return /^[A-Za-z0-9_-]{22,64}$/.test(tagId);
}

/** The path written onto a physical Tag. Frozen by ADR 0001. */
export function tagPath(tagId: string): string {
  return `/nfc/${tagId}`;
}

export type TagView = {
  id: string;
  path: string;
  chore: { id: string; name: string } | null;
};

/** A Tag as the Scan resolver needs it; null when the id is unknown. */
export type TagRecord = {
  id: string;
  householdId: string;
  /** The linked Chore, or null when none is linked or the linked Chore is Archived. */
  chore: { id: string; name: string } | null;
};

export type LinkResult = { ok: true; tag: TagView } | { ok: false; error: "tag_not_found" | "chore_not_found" };

export async function findTag(db: Db, tagId: string): Promise<TagRecord | null> {
  const [r] = await db`
    SELECT t.id, t.household_id, ch.id AS chore_id, ch.name AS chore_name
    FROM tags t LEFT JOIN chores ch ON ch.id = t.chore_id AND ch.archived_at IS NULL
    WHERE t.id = ${tagId}`;
  if (!r) return null;
  return {
    id: r.id,
    householdId: r.household_id,
    chore: r.chore_id ? { id: r.chore_id, name: r.chore_name } : null,
  };
}

export async function listTags(db: Db, householdId: string): Promise<TagView[]> {
  const rows = await db`
    SELECT t.id, ch.id AS chore_id, ch.name AS chore_name
    FROM tags t LEFT JOIN chores ch ON ch.id = t.chore_id AND ch.archived_at IS NULL
    WHERE t.household_id = ${householdId}
    ORDER BY t.created_at, t.id`;
  return rows.map(toView);
}

export async function createTag(
  deps: { db: Db; clock: Clock },
  input: { householdId: string; createdBy: string; choreId: string | null },
): Promise<LinkResult> {
  const { db, clock } = deps;
  if (input.choreId && !(await choreInHousehold(db, input.householdId, input.choreId))) {
    return { ok: false, error: "chore_not_found" };
  }
  const id = newTagId();
  await db`
    INSERT INTO tags (id, household_id, chore_id, created_at, created_by)
    VALUES (${id}, ${input.householdId}, ${input.choreId}, ${clock.now()}, ${input.createdBy})`;
  return { ok: true, tag: (await viewOf(db, input.householdId, id))! };
}

export type ClaimResult =
  | { ok: true; tag: TagView }
  | { ok: false; error: "malformed_tag_id" | "already_registered" | "chore_not_found" };

/**
 * Registers an Unregistered Tag (a well-formed ID nobody has registered yet)
 * to the Household under the scanned ID, pointing at a Chore or none. A Tag
 * that already exists, in any Household, is never taken over.
 */
export async function claimTag(
  deps: { db: Db; clock: Clock },
  input: { householdId: string; tagId: string; claimedBy: string; choreId: string | null },
): Promise<ClaimResult> {
  const { db, clock } = deps;
  if (!isWellFormedTagId(input.tagId)) return { ok: false, error: "malformed_tag_id" };
  if (input.choreId && !(await choreInHousehold(db, input.householdId, input.choreId))) {
    return { ok: false, error: "chore_not_found" };
  }
  const inserted = await db`
    INSERT INTO tags (id, household_id, chore_id, created_at, created_by)
    VALUES (${input.tagId}, ${input.householdId}, ${input.choreId}, ${clock.now()}, ${input.claimedBy})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) return { ok: false, error: "already_registered" };
  return { ok: true, tag: (await viewOf(db, input.householdId, input.tagId))! };
}

/** Points the Tag at a Chore of the same Household, or at none. */
export async function linkTag(
  db: Db,
  input: { householdId: string; tagId: string; choreId: string | null },
): Promise<LinkResult> {
  if (input.choreId && !(await choreInHousehold(db, input.householdId, input.choreId))) {
    return { ok: false, error: "chore_not_found" };
  }
  const updated = await db`
    UPDATE tags SET chore_id = ${input.choreId}
    WHERE id = ${input.tagId} AND household_id = ${input.householdId}
    RETURNING id`;
  if (updated.length === 0) return { ok: false, error: "tag_not_found" };
  return { ok: true, tag: (await viewOf(db, input.householdId, input.tagId))! };
}

/**
 * Hard-deletes a Tag that no Completion records. A Tag with history stays
 * (unlink it instead). A deleted Tag's ID is no longer known, so scanning it
 * again reports it as Unregistered.
 */
export async function deleteTag(
  db: Db,
  input: { householdId: string; tagId: string },
): Promise<{ ok: true } | { ok: false; error: "not_found" | "has_history" }> {
  const [tag] = await db`SELECT id FROM tags WHERE id = ${input.tagId} AND household_id = ${input.householdId}`;
  if (!tag) return { ok: false, error: "not_found" };
  try {
    const deleted = await db`
      DELETE FROM tags
      WHERE id = ${tag.id} AND NOT EXISTS (SELECT 1 FROM completions WHERE tag_id = ${tag.id})
      RETURNING id`;
    return deleted.length > 0 ? { ok: true } : { ok: false, error: "has_history" };
  } catch (e) {
    const err = e as { errno?: string; code?: string };
    if (err?.errno === "23503" || err?.code === "23503") return { ok: false, error: "has_history" };
    throw e;
  }
}

async function choreInHousehold(db: Db, householdId: string, choreId: string): Promise<boolean> {
  const rows = await db`
    SELECT 1 FROM chores
    WHERE id = ${choreId}::uuid AND household_id = ${householdId} AND archived_at IS NULL`.catch(() => []);
  return rows.length > 0;
}

async function viewOf(db: Db, householdId: string, tagId: string): Promise<TagView | null> {
  const [r] = await db`
    SELECT t.id, ch.id AS chore_id, ch.name AS chore_name
    FROM tags t LEFT JOIN chores ch ON ch.id = t.chore_id AND ch.archived_at IS NULL
    WHERE t.id = ${tagId} AND t.household_id = ${householdId}`;
  return r ? toView(r) : null;
}

function toView(r: any): TagView {
  return {
    id: r.id,
    path: tagPath(r.id),
    chore: r.chore_id ? { id: r.chore_id, name: r.chore_name } : null,
  };
}
