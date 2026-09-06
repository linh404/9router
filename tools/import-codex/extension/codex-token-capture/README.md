# Codex OAuth Token Capture v1.0.4

This is a local unpacked Chrome extension for manual OAuth login.

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose `Load unpacked` and select this directory.
4. Enable `Allow in incognito` for the extension.
5. Click the extension icon, then `Bắt đầu OAuth`.
6. Complete login and 2FA manually.
7. When the callback reaches `localhost:1455`, the extension exchanges the code and downloads `codex-oauth-token.json`.

After reloading the extension, the callback tab is replaced with a success or error page instead of showing `ERR_CONNECTION_REFUSED`.

The extension does not read cookies, passwords, or 2FA secrets. The downloaded JSON contains only OAuth token fields and can be imported into the existing importer.
