# Identity and access

The library has no passwords of its own. People sign in with an OpenID
Connect (OIDC) provider, and a **directory** decides who has access, who is
an admin, and which team each person belongs to.

- **Manual directory** (`DIRECTORY=manual`, the default): admins invite people
  by email and manage teams in the library. Works with any OIDC provider.
- **Keycloak directory** (`DIRECTORY=keycloak`): people, admins, and teams
  come from Keycloak groups and are synced every 15 minutes.

| Provider | Login | Directory |
|---|---|---|
| Keycloak | OIDC | `manual` or `keycloak` |
| Microsoft Entra ID, Google, Okta, Authentik, Zitadel, or another OIDC provider | OIDC | `manual` |

Admins are the library's **stewards**: they maintain the taxonomy, decide
uploads on hold, check and delete notes, and manage people and teams.

Whichever directory you use, the library never deletes people. Someone who
leaves loses access, and their name stays on their notes.

## Who sees a note

| Note | Who sees it |
|---|---|
| Draft or discarded | Its owner (the uploader) and the stewards; private ones only the owner |
| Published, "Everyone" | Everyone with access |
| Published, "My team" | The owner's team, the owner, and the stewards |
| Published, "Only me" | The owner only. Never sent to the webhook or a digest |

## OpenID Connect login

Register the library as a confidential client (authorization code flow with
PKCE) at your provider:

| Setting | Value |
|---|---|
| Redirect URI | `<LIBRARY_BASE_URL>/api/auth/callback/oidc` |
| Post-logout redirect URI | `<LIBRARY_BASE_URL>/` |
| Scopes | `openid profile email` |
| Client authentication | Client secret |

Then set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`. The
library reads the provider's endpoints from
`<OIDC_ISSUER>/.well-known/openid-configuration`. If the provider publishes an
`end_session_endpoint`, signing out of the library also signs out of the
provider. `OIDC_SCOPES` changes the requested scopes (default
`openid profile email`).

Typical issuer URLs:

| Provider | `OIDC_ISSUER` |
|---|---|
| Keycloak | `https://<host>/realms/<realm>` |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Google | `https://accounts.google.com` |
| Okta | `https://<org>.okta.com` |
| Authentik | `https://<host>/application/o/<slug>/` |
| Zitadel | `https://<instance domain>` |

The provider must send the `email` claim, and `email_verified` must be true
for invitations and `INITIAL_ADMIN_EMAILS` to match. A login is linked to a
person by the OIDC subject (`sub`) after that. Each session belongs to the
`sub` it signed in with, so two provider accounts with the same email address
(for example a deleted and recreated account) never share a session.

Some providers never send `email_verified=true`: Microsoft Entra ID does not
send the claim, and Authentik depends on its scope mapping. If your users
cannot choose their own email address at the provider (it is managed by your
organization), set `OIDC_TRUST_EMAIL=true`. Do not set it for providers where
people sign up themselves or edit their address, since an invitation would
then go to whoever enters that address first.

## Manual directory

1. Set `INITIAL_ADMIN_EMAILS` (required) to your own email address and sign
   in. While the library has no admin, the first login whose verified email
   is in that list becomes an admin.
2. Under **Admin → Teams**, create the teams. A note's "My team" visibility
   means its owner's team; people without a team can share with everyone or
   keep notes to themselves.
3. Under **Admin → People**, invite people with their email address, a name,
   and optionally a team. An invited person gets access at their first login
   with the same verified email address; the name from the provider then
   replaces the one in the invitation.
4. On the same page, admins change names and teams, make people admins, and
   take access away. Taking access away ends the person's sessions at once.
   Nobody can take away their own access, and the last admin always stays.

Anyone else who signs in at the provider sees "No access".

## Keycloak directory

The library reads the members of three Keycloak groups through the Keycloak
Admin API. All three are required:

- Members of `KEYCLOAK_ACCESS_GROUP`, and of its subgroups, have access.
  Disabled users do not.
- Members of `KEYCLOAK_ADMIN_GROUP` (and its subgroups) are admins, and have
  access too.
- Each direct subgroup of `KEYCLOAK_TEAMS_GROUP` is a team (the group itself
  is not). A person in several teams belongs to the first one by name.
  Members of a team's subgroups belong to that team. Being in a team does not
  grant access; set `KEYCLOAK_ACCESS_GROUP` to the teams group if every team
  member should have it.
- Teams are matched by their Keycloak group ID: renaming a group renames the
  team, and notes keep it. A team group that is removed becomes an
  inactive team, kept on its notes.

For example:

```text
/library            ← KEYCLOAK_ACCESS_GROUP=/library
/library-admins     ← KEYCLOAK_ADMIN_GROUP=/library-admins (the stewards)
/teams              ← KEYCLOAK_TEAMS_GROUP=/teams
  /Engineering
  /Operations
```

The worker syncs every 15 minutes and once at startup. An admin can start a
sync on the admin page. People missing from the groups lose access, and their
sessions end. A failed sync, or one that would find nobody, keeps the last
state and shows the error on the admin page; so does a sync that finds no
team. Someone who signs in before the next sync triggers a sync of their own
(at most once a minute).

### Keycloak setup

1. Create a client, e.g. `library`:
   - Client authentication: on
   - Authentication flow: standard flow, with PKCE method S256
   - Service accounts: on (for the sync)
   - Valid redirect URIs: `<LIBRARY_BASE_URL>/api/auth/callback/oidc`
   - Valid post-logout redirect URIs: `<LIBRARY_BASE_URL>/`
   - Web origins: `<LIBRARY_BASE_URL>`
2. Under the client's **Service account roles**, assign the role
   `view-users` of the client `realm-management`. It lets the sync read users
   and group members, nothing else.
3. Create the groups and add people to them.
4. Set:

   ```sh
   OIDC_ISSUER=https://auth.example.org/realms/acme
   OIDC_CLIENT_ID=library
   OIDC_CLIENT_SECRET=…
   DIRECTORY=keycloak
   KEYCLOAK_ACCESS_GROUP=/library
   KEYCLOAK_ADMIN_GROUP=/library-admins
   KEYCLOAK_TEAMS_GROUP=/teams
   ```

To keep login and sync apart, create a second client with only service
accounts on, give it the `view-users` role, and set `KEYCLOAK_CLIENT_ID` and
`KEYCLOAK_CLIENT_SECRET` to it.

[`dev/keycloak/library-realm.json`](../dev/keycloak/library-realm.json) is a
complete example realm, used by the development setup (`compose.dev.yaml`)
and the end-to-end tests.

## Other providers

With Microsoft Entra ID, Google, Okta, Authentik, Zitadel, or any other OIDC
provider, use the manual directory: the provider handles the login, and
admins manage people and teams in the library. For Microsoft Entra ID, set
`OIDC_TRUST_EMAIL=true` (see above) when your organization manages the
addresses. The library does not read groups from these providers: anyone who
can sign in at the provider but was not invited sees "No access".

## Switching directories

People invited in the manual directory lose access at the first Keycloak
sync unless they are members of the access group: the sync creates its own
people, keyed by their Keycloak user ID. Their earlier notes stay under
their old person record. Teams created in the library become inactive at the
same sync: they stay on their notes, but new notes use the teams from
Keycloak.

Switching back from Keycloak to the manual directory keeps everyone's access
as it was at the last sync. From then on, admins manage all people and teams
in the library, including those that came from Keycloak. If you switch to
Keycloak again later, the sync finds the same people and teams by their
Keycloak IDs and overwrites the changes made in the library.
