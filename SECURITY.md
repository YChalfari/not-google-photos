# Security

Not Google Photos is a household server. It is not a public photo site.

Keep it on your home network, or reach it through Tailscale. A Cloudflare Tunnel puts it on the internet. If you do that, keep the server updated, and leave the session cookie and device-token sign-in on. The README has the setup.

When you report a problem, do not include photos, pairing codes, or your `.env`.

Use a [private security advisory](https://github.com/YChalfari/not-google-photos/security/advisories/new) for a vulnerability. Please do not open a public issue for one.
