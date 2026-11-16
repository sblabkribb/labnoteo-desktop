# labnoteO Desktop privacy policy

Last reviewed: 2026-11-13.

## Local data

Notebook files and attachments are stored in the folder selected by the user.
Search indexes, settings, and assistant history are stored locally. API keys and
integration tokens are stored in Windows Credential Manager. Exporting a connection
file or sharing files is a separate user-directed action; treat any such file as
potentially sensitive.

## Network connections

The desktop app checks GitHub Releases for updates on startup, periodically, and
when requested. When an update is available, it can download the installer in the
background; installation requires the user's action. These requests expose ordinary
network information, such as the client IP address, to GitHub. Notebook content is
not needed for update checks. See [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

Optional integrations make requests to the services selected or connected by the
user. These include AI providers, PartBank, bfworkflow, SearXNG, Slack, GitHub,
assistant web/literature tools, and MCP servers. Depending on the operation, requests
can include prompts, selected note context, search terms, attachments, or files chosen
for upload. Connected tools may read or modify data within the permissions granted
to them. Use only services and servers you trust, and review their privacy policies
before sending research or personal data.

For GitHub and Slack, see the [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
and [Slack privacy policy](https://slack.com/trust/privacy/privacy-policy). For a
configured AI endpoint (including self-hosted endpoints), research service, search
server, web destination, or MCP server, the operator of that exact service determines
its retention and processing practices. If using OpenAI's API directly, see
[OpenAI's privacy policy](https://openai.com/policies/privacy-policy/).

The application does not include a dedicated usage-analytics or advertising SDK.
Automatic update requests and configured integration requests are still network
traffic and should not be interpreted as offline operation.

## Signing and support

Code signing is performed in the release build process, outside users' notebook
sessions. The planned SignPath integration submits public-release executables and
build provenance, not users' notebooks or API keys. See the
[code signing policy](CODE_SIGNING_POLICY.md).

If you open a public GitHub issue, its contents are public. Remove research data,
credentials, and personal information from screenshots and logs before posting.
