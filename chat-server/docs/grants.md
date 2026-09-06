# Required grants by object and use case

Applies only when `Authorization: Bearer` is present. No header → no claim check.

Two layers:

| Layer | Where | Meaning |
|---|---|---|
| Authorization | `*_authorizations` | Ceiling: user *may* claim this workspace/wallet |
| Token claim | `oauth_tokens.grants_json` | What *this* token actually allows |

Issue-time: claim ⊆ authorization. Use-time: resource partition ⊆ token claims + verb.

Claim verbs:

| Claim | Access | HTTP (when Bearer set) |
|---|---|---|
| Topic / workspace | `read` | GET, HEAD |
| Topic / workspace | `write` | POST, PUT, PATCH, DELETE (includes read) |
| Provider / wallet | `run` | GET providers/models; use `modelId`/`providerId` on a node |
| Provider / wallet | `manage` | create/update/delete providers and models (includes run) |

`write` on studio A does not imply `write` on studio B. The single wallet claim does not apply to another wallet.

---

## Identity

| Use case | Required when Bearer present |
|---|---|
| `GET /api/users` | Token subject only (list shrinks to that user) |
| `POST /api/users` | None (creating an identity) |
| `POST /api/users/login` | None (password check only; no token) |
| `GET/PUT/DELETE /api/users/{id}` | `token.userId == {id}` |
| `GET /api/users/{id}/content-clients` etc. | Same self check |

No topic or wallet claim. Reasonable.

---

## Token

| Use case | Required |
|---|---|
| `POST /api/oauth/token` password | Valid user password + live authorization for every requested claim |
| `POST /api/oauth/token` refresh | Valid refresh token; claims re-checked against live grants |
| `POST /api/oauth/introspect` | None (token is in the body) |
| `POST /api/oauth/revoke` | None |
| `GET /api/oauth/tokeninfo` | Valid access token (`401` if missing) |

---

## Workspace (`content_clients`)

| Use case | Topic claim |
|---|---|
| List workspaces | `read` on each returned id (list filtered to claimed studios) |
| Get workspace `{id}` | `read` (GET) / `write` (if method were mutating) on `{id}` |
| Create workspace | **Forbidden** if any Bearer is present |
| Update / delete workspace | `write` on that workspace |
| List / create / revoke user authorizations on `{id}` | GET → `read`; POST/DELETE → `write` on `{id}` |
| List topics of workspace | `read` on `{id}` |

---

## Wallet (`provider_clients`)

| Use case | Provider claim |
|---|---|
| List wallets | `run` (GET) on the token wallet; list is that one id |
| Get / list authorizations | `run` on that wallet (must be the token wallet) |
| Create wallet | **Forbidden** if any Bearer is present |
| Update / delete wallet | `manage` |
| Grant / revoke wallet authorizations | POST/DELETE → `manage` |

---

## Topics

| Use case | Topic claim on `topic.content_client_id` |
|---|---|
| List topics | `read` on **some** claimed workspace; **list is filtered to the first topic claim only** (see gaps) |
| Get topic | `read` |
| Create topic | `write` on the target workspace |
| Update / delete topic | `write` |
| Attach / detach project | `write` |

---

## Projects

| Use case | Topic claim on the project's topic workspace |
|---|---|
| List projects | `read`; filtered to all claimed workspaces |
| Get / create / update / delete | GET `read`, mutate `write` |
| Create without `topicId` | Uses a topic from a claimed workspace |

A project with several topics is authorized via one resolved workspace (`contentClientIdOfProject` takes the first join row).

---

## Chats and nodes

| Use case | Required claims |
|---|---|
| List chats | Topic `read` on claimed workspaces (all ids) |
| Get chat / list nodes | Topic `read` on the chat's workspace |
| Create / rename / delete chat | Topic `write` |
| Reassign `projectId` | Topic `write` on the **new** project's workspace |
| Add/edit node without model | Topic `write` |
| Add/edit node **with** `modelId` or `providerId` | Topic `write` **and** wallet `run` or `manage` on that provider's wallet **and** contingent not exhausted |

Unassigning a chat keeps it in the topic inbox project; the workspace does not change, so the same topic claim still applies.

---

## Providers and models

| Use case | Provider claim |
|---|---|
| List / get providers and models | `run` (GET) on the token wallet; lists filtered to that wallet |
| Create / update / delete provider | `manage` |
| Create / update / toggle / delete model | `manage` |
| Spend the key from a chat node | `run` or `manage` + contingent |

Two wallets offering the same model id are two provider rows. The node names `providerId`; the token wallet must own that row.

---

## Personas

Content. Owned by a workspace (`content_client_id`).

| Use case | Topic claim |
|---|---|
| List / get | `read` on that workspace |
| Create / update / delete | `write` |

## Chat parameters

Two kinds on the same table:

| Kind | Typical owners | Claim |
|---|---|---|
| `content` (`content_client_id`) | chats, chat_nodes — documentation of what was used | topic `read` / `write` |
| `run` (`provider_client_id`) | topics, projects, models — generation settings | wallet `run` / `manage` |

Attaching a `run` set to a chat, or a `content` set to a topic/project/model, is `400`.
Legacy rows with neither owner stay attachable without a Bearer.

---

## Reasonableness

**Sound**
- Verbs on claims, partitions on claims (ABAC + small RBAC).
- N workspaces with different `read`/`write` on one token; opposite rights on A vs B work.
- Exactly one wallet per token; keys stay inside that vault.
- Chat write vs model run are separate claims. An editor without a wallet cannot spend keys; a runner without `write` cannot append to the chat.
- Contingent is the right place for spend caps (attribute, not a scope).
- Self-only user profile checks.
- Opaque token; claims stay on the server.

**Weak or inconsistent**

1. **No Bearer = full access.** Fine for a local desktop. Not fine if the API is reachable on a network. Documented, but it is an implicit “admin” mode.

2. **`GET /api/topics` uses only the first topic claim.** Chats and projects use *all* claimed workspaces. A token with A+B lists chats from both but topics from A only. That should use `authClientIds(req, 'content')` like the others.

3. **Personas and chat parameters have no tenant.** A token for studio A can edit global personas used by studio B. Either leave them global on purpose or hang them off a workspace.

4. **`topics.share` was designed and not implemented.** Granting another user on a workspace only needs topic `write`. Any editor can mint authorizations, including `topics.write` for someone else. That should be owner-only or a `share` access.

5. **Create workspace/wallet is forbidden whenever a Bearer is present.** So a logged-in app cannot create a second studio without dropping the header. Reasonable if creation is a setup-only call; awkward for an in-app “new workspace” button (needs a token with no partition claims, or a dedicated admin token).

6. **`manage` includes `run`, but listing keys is GET = `run`.** A `run` token can `GET /api/providers` and see `apiKey`. If keys must stay hidden from callers, list-with-key needs `manage` and `run` should see metadata only.

7. **Multi-topic projects.** Authorization uses one workspace from the join table. A project shared across two topics in two studios is allowed if *either* first-row workspace matches. Define “primary topic” or require a claim on every attached workspace.

8. **Issuance vs use for provider scopes.** Authorization `providers.read` becomes token `run`; `providers.write` becomes `manage`. The names differ. Harmless if documented; confusing in `/authorizations` vs `/token`.

**Suggested default policy (if you tighten later)**

| Action | Claim |
|---|---|
| See topics/chats | topic `read` |
| Edit topics/chats/nodes | topic `write` |
| Invite users to a workspace | topic `share` or owner only |
| See model catalog / call a model | wallet `run` (no raw key in GET) |
| CRUD keys | wallet `manage` |
| Personas / parameters | topic `write` of a home workspace, or keep global and say so |
| Create workspace | special setup token or no-Bearer bootstrap only |

Until then, treat the table above as the **implemented** contract, including the gaps.
