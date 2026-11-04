/** Random bearer tokens (session cookies, Invite and magic links). Only their hashes are stored. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
