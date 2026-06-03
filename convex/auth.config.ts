import { AuthConfig } from 'convex/server'

export default {
  providers: [
    // Web app (dashboard) — Clerk `convex` JWT template.
    {
      // Replace with your Clerk Frontend API URL
      // or with `process.env.CLERK_JWT_ISSUER_DOMAIN`
      // and configure CLERK_JWT_ISSUER_DOMAIN on the Convex Dashboard
      // See https://docs.convex.dev/auth/clerk#configuring-dev-and-prod-instances
      domain: process.env.CLERK_FRONTEND_API_URL!,
      applicationID: 'convex',
    },
    // CLI — Clerk OAuth application JWT access tokens. `aud` is the OAuth
    // Client ID (set CLERK_OAUTH_CLIENT_ID on the Convex deployment), not the
    // `convex` template name. Validated offline via the same issuer JWKS.
    // See docs/superpowers/specs/2026-06-03-cli-oauth-pkce-design.md §3.
    {
      domain: process.env.CLERK_FRONTEND_API_URL!,
      applicationID: process.env.CLERK_OAUTH_CLIENT_ID!,
    },
  ],
} satisfies AuthConfig
