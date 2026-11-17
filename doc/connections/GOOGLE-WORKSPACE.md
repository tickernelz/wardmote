# Google Workspace connections

The Connectors page shows two Google cards:

- **Google Workspace** (`google-workspace`): one connection for Drive, Sheets, Docs, Slides, Calendar, Gmail, Forms, Tasks, Chat, Meet, Contacts (People) and Apps Script. Agents call the public Google REST APIs through the Wardmote tool gateway; the server reads each API's Discovery document and decides every call.
- **Google Workspace Search** (`google-workspace-search`): Google's hosted Workspace MCP server (Developer Preview), unchanged.

The eight per-service hosted-MCP cards (Gmail, Drive, Docs, Sheets, Slides, Calendar, Chat, People) are withheld from the store (`RETIRED_GOOGLE_SERVICE_SLUGS` in `packages/shared/src/app-definitions.ts`). Their definitions stay so a saved connection keeps working and stays listed on the Connectors page; no new connection can be created from them. The Google Sheets robot-account method lives on the retired Sheets card until service-account support lands on the Google Workspace card.

## Setup

Connect Google Workspace walks through five steps:

1. **Who uses it**: your own Google OAuth app or an existing `client_secret.json`; personal or organization credential; which agents.
2. **Google Cloud**: links to create a project, enable all twelve APIs in one `flows/enableapi` link (or the shown `gcloud services enable` command), set the consent screen Audience (Workspace: Internal; personal Gmail: External, then Publish, because Testing-mode authorizations expire after seven days) and create a Web application client. The redirect URI is the instance's `/api/tools/oauth/callback`.
3. **Credentials**: paste the Client ID and secret, or drop `client_secret.json`. The file is checked for a Web client, a secret and this instance's redirect URI.
4. **Capabilities**: a level per service: Off, Read, Edit, Create & upload, Delete & share. Wardmote asks Google only for the scopes of the chosen levels (`googleWorkspaceScopesFor`) with `include_granted_scopes=true`. Restricted scopes are labelled: `drive`, `drive.readonly`, `gmail.readonly`, `gmail.modify`, `gmail.compose` ([Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)). Drive "Delete & share" uses the restricted `drive` scope.
5. **Test**: after Google consent, the connection page's Test panel runs one cheap read per active service (`drive.about.get`, `calendarList.list`, `users.getProfile`, `tasklists.list`, …) and shows the policy verdict of a dry-run write. A disabled API shows Google's own activation link.

The levels, approval policy, Drive limits and domain can be changed later on the connection page. Raising a level shows the scopes Google has not granted yet and a button that asks Google for just those.

## Agent tools

`google_search_methods`, `google_describe`, `google_call` plus helpers (`google_sheets_append`, `google_drive_upload`, `google_drive_share`, `google_docs_write`, `google_calendar_insert`, `google_gmail_send`, …). Results carry `untrusted: true`: document contents are data, never instructions. Uploads and downloads go through task attachments; Drive delete moves to trash unless `permanentDelete` is set.

## Policy

Every method, and every request kind inside a `batchUpdate`, has a server-reviewed class (`server/src/services/google-workspace/method-review.json`); a method or kind not in the table is `unreviewed`. Some write methods are reclassified by body: an update that trashes a file, cancels an event, deletes a task, adds the TRASH label, or a Gmail filter that forwards mail.

| Class | Default |
| --- | --- |
| read | runs |
| write | runs |
| destructive | asks for approval |
| external (share outside the domain, send email, notification channels) | asks for approval |
| unreviewed | asks for approval |
| execute (Apps Script) | blocked |

The connection owner can change each class to run, ask or block, per connection. Emptying the Drive trash is always blocked. Sharing inside the configured domain counts as write.

Approvals are bound to what the card showed: the gateway stores the classes and outside recipients on the invocation, and an approved call is refused if the fresh decision differs (for example a draft whose recipients changed). Non-idempotent calls are never retried after a timeout; the result says the outcome is unknown.

Drive limits (folders, shared drives, spreadsheets) apply to Drive, Sheets, Docs, Slides and Forms: a file must sit below an allowed folder or shared drive, `files.list` gets the folder clause added by the server, and reads without a file target are blocked unless they cannot reveal files outside the limits.

## Revoking

Removing a Google authorization on the connection page revokes its refresh token at `https://oauth2.googleapis.com/revoke` and records `providerRevocation` in the audit event. A failure at Google never blocks the local revoke.

## Google Workspace Search (hosted MCP)

### Developer Preview enrollment

Google grants preview access to the specific Workspace email addresses and
Google Cloud project numbers registered with the program. Submitting the form
is not the approval signal:

1. Google first sends a Google Group membership notification after verifying
   the Workspace account.
2. Google then sends a final confirmation after registering the Cloud project,
   usually within a couple of days. This final email is the signal that MCP
   testing can begin.
3. If no final confirmation arrives within a week, check spam and contact the
   Developer Preview program team from the
   [program page](https://developers.google.com/workspace/preview).

Enrollment does not authorize every user of an OAuth client. Additional tester
emails and Cloud projects must be added through Google's member request forms.
Google's preview terms also prohibit making a pre-GA integration available to
end users outside the enrolled company or domain unless Google grants explicit
permission. Each company enrolls its own Workspace testers and Cloud project and
