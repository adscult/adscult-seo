# Team deployment on Coolify

This configuration serves `seo.adscult.tech` behind Cloudflare Access. Admitted
users share one workspace and start as Members. Members can run research,
tracking, and paid API operations. Admins can also create/archive projects,
manage providers and integrations, and change Member/Admin roles. Owner identities
come from deployment configuration and have full workspace control.

Team addresses use `@adscult.com`; the application hostname remains
`seo.adscult.tech`. Microsoft 365 manages the mailboxes. People join the app on
their first successful sign-in, so there is no separate app invitation or
password to create. The team page only changes Member/Admin roles.

## Cloudflare

1. In Cloudflare Zero Trust, create a Self-hosted Access application covering
   `seo.adscult.tech`, with no path restriction.
2. Add an Allow policy with **Include > Emails ending in > `adscult.com`**.
   Select email one-time PIN as the application's login method and add
   **Require > Login methods > One-time PIN** to that same Allow policy. Users
   receive a sign-in code in their Microsoft 365 inbox. If only selected employees should have access,
   list those full email addresses instead of allowing the whole domain.
   Do not add an Everyone or Bypass policy.
3. Copy the team URL (`https://<team>.cloudflareaccess.com`) and this application's
   audience tag (AUD).
4. Create a proxied DNS record for `seo` pointing to the VPS. Configure a valid
   origin certificate in Coolify and use Cloudflare Full (strict) TLS.

The app validates Access JWTs itself. Keep port 3001 unpublished. A Cloudflare
Tunnel is an alternative to the public reverse proxy; it must also have the
Access application applied to its hostname.

### Daily user management

- Add a teammate: create or enable their company account in Microsoft 365. With
  the domain policy above, they can sign in and appear as a Member automatically.
- Promote or demote: use Settings > Organization to choose Member or Admin.
  Members may run paid checks; Admins also manage workspace settings and roles.
- Remove access: add their address under **Exclude > Emails** in the domain's
  Allow policy and revoke their existing Cloudflare Access sessions. Disable
  their Microsoft account through the company's usual offboarding process.
  For individual email policies, remove their address from the Allow policy.

## Coolify

1. Push the intended source changes, including `compose.coolify.yaml`, to the
   repository and branch Coolify will build. The upstream published image does
   not include this fork's local changes.
2. Create an application from the Git repository. Select Docker Compose, base
   directory `/`, and Compose location `/compose.coolify.yaml`.
3. Set the `open-seo` service domain to `https://seo.adscult.tech:3001`. The suffix
   tells Coolify which container port to route to; users visit the HTTPS URL
   without a port. Do not add a host port mapping.
4. Enter the required runtime values in Coolify's Environment Variables:

   ```env
   TEAM_DOMAIN=https://<team>.cloudflareaccess.com
   POLICY_AUD=<application-audience>
   SELFHOST_OWNER_EMAILS=arsalan@adscult.com
   TREG_TOKEN=<treg-token>
   SEO_PROVIDER_SECRET_v1=<stable-random-secret-at-least-32-characters>
   ```

   Keep secrets in Coolify. Generate a fresh encryption secret with
   `openssl rand -hex 32` when starting an empty installation. Preserve that
   secret across redeployments and backups.

   The Compose default makes `arsalan@adscult.com` the initial Owner. Override
   `SELFHOST_OWNER_EMAILS` only to change owners or configure a comma-separated
   list of trusted owners. Cloudflare Access must also allow those identities.
   The app never grants ownership based on who signs in first. Changing owner
   configuration requires a redeployment. Remove sign-in access through
   Cloudflare Access when someone leaves the team.

5. Deploy. Startup applies SQLite migrations, builds the application, and starts
   the scheduler. The Dockerfile health check allows five minutes for startup.
   Persistent application data lives in the `open_seo_data` volume at
   `/app/.wrangler`. Keep a single application replica and back up this volume
   and the encryption secret.

Optional AI and Google credentials are forwarded by the Compose file. Enter
them in Coolify only if those features are needed.

## First deployment checks

- Confirm container health and `/api/health` inside the container.
- Open the domain in a private browser window. Confirm Access requires login;
  an email outside the Allow policy must not reach the app.
- Sign in as a configured owner. Confirm provider settings show Treg. Open
  Settings > Organization to assign Admin/Member roles after people first sign
  in. Owners cannot be demoted in that page; update deployment configuration.
- Sign in as another allowed team member and confirm both see the same project.
  Members must see no provider editor or role-change controls. Admins should see
  both. Members can still run paid checks using the workspace provider.
- Test access protection before enabling tracking schedules or running paid
  searches. Do not purchase API operations merely to check deployment health.
- Redeploy and confirm the project remains available through persistent storage.

This starts with an empty database. Importing the existing local installation
requires a separate backup and migration. Switching from local-noauth mode to
Access also changes the workspace; provider configuration must be checked in the
shared workspace. Environment provider values apply only where no saved
organization override exists.

References:

- [Coolify Docker Compose applications](https://coolify.io/docs/applications/builds/docker-compose)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Cloudflare email sign-in codes](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
