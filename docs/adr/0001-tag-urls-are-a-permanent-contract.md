# Tag URLs are a permanent contract

Each NFC Tag stores a plain HTTPS URL of the form `https://<owned-domain>/nfc/{tagId}`, where `{tagId}` is random and unguessable and the domain is one we own (never a hosting provider's subdomain). Because the URL is written onto physical objects, the domain and the `/nfc/{tagId}` path are frozen: changing them means reprogramming every tag in every household. Chore assignment lives server-side so tags never need rewriting, and a future native app takes over the same URLs through Universal Links / App Links instead of introducing a new scheme.

## Considered Options

- **Apple Shortcuts NFC automations**: rejected because they need per-device, per-tag setup.
- **Custom URL scheme (`chores://`)**: rejected because it does nothing without a native app installed and cannot fall back to the web.
- **Encoding the chore in the URL**: rejected because it would need a physical rewrite to reassign a tag.
