# PlantUML diagrams

One diagram per file. Render with:

```bash
plantuml docs/diagrams/*.puml
```

`01-schema.puml` needs Graphviz/`dot`. The sequence diagrams do not.

| File | Contents |
|---|---|
| `01-schema.puml` | Tables and FKs. `content_clients` = workspaces, `provider_clients` = wallets. |
| `02-token-claims.puml` | Opaque Bearer; ABAC claims in `oauth_tokens.grants_json`. |
| `03-grant-definition.puml` | User + workspace/wallet grants (issuance ceiling). |
| `04-token-issue.puml` | Password grant stores N topic claims + one provider claim. |
| `05-chat-write-claim-check.puml` | Chat/node write checks the matching topic claim. |
| `06-model-use-contingent.puml` | Model call checks wallet claim and contingent. |
| `07-bearer-vs-none.puml` | No `Authorization` header skips claim checks. |
| `08-claim-resolution.puml` | Chat/model walk onto token claims. |
