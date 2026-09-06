const express = require('express');
const {
  issueTokensForGrant,
  refreshAccessToken,
  validateAccessToken,
  revokeToken,
  requireAuth
} = require('../oauth');
const { findUserByLogin, verifyPassword, normalizeOptional } = require('../users');

const router = express.Router();

/**
 * @openapi
 * /api/oauth/token:
 *   post:
 *     summary: Issue an opaque access token with server-side claims
 *     description: |
 *       Supported grant_type values:
 *       - password: username/email/phone + password + claims (or legacy client_id)
 *       - refresh_token: refresh_token (copies stored claims)
 *
 *       The Bearer string contains no claims. Topic and provider claims are stored on the token row.
 *       Each topic claim requires a granted content-client authorization whose scopes cover read or write.
 *       At most one provider claim is allowed; it requires a granted provider-client authorization.
 *       `run` may call models; `manage` may change API keys. Optional `contingent` caps spentCost/spentTokens.
 *     tags:
 *       - OAuth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TokenRequest'
 *     responses:
 *       200:
 *         description: Issued token handle plus a copy of the stored claims
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TokenResponse'
 *       400:
 *         description: Missing credentials/claims, unknown partition, or more than one wallet
 *       401:
 *         description: Invalid username or password
 *       403:
 *         description: No grant, or requested access exceeds the authorization ceiling
 */
router.post('/token', async (req, res) => {
  const grantType = req.body.grant_type || req.body.grantType;

  if (grantType === 'refresh_token') {
    const refresh = req.body.refresh_token || req.body.refreshToken;
    const result = refreshAccessToken(refresh);
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json(result.token);
  }

  if (grantType && grantType !== 'password') {
    return res.status(400).json({ error: 'unsupported grant_type' });
  }

  const username = normalizeOptional(req.body.username);
  const email = normalizeOptional(req.body.email);
  const phoneNumber = normalizeOptional(req.body.phoneNumber ?? req.body.phone_number);
  const password = req.body.password;
  const clientId = req.body.client_id || req.body.clientId;
  const extraClientIds = req.body.wallet_ids
    || req.body.walletIds
    || req.body.additional_client_ids
    || req.body.additionalClientIds
    || [];
  const claims = req.body.claims;
  const topicClaims = req.body.topicClaims || req.body.topic_claims;
  const providerClaim = req.body.providerClaim || req.body.provider_claim;

  if (!password) return res.status(400).json({ error: 'password is required' });
  if (!username && !email && !phoneNumber) {
    return res.status(400).json({ error: 'username, email or phoneNumber is required' });
  }
  const hasClaims = !!(claims || topicClaims || providerClaim);
  if (!clientId && !hasClaims) {
    return res.status(400).json({ error: 'claims or client_id is required' });
  }

  const user = findUserByLogin({ username, email, phoneNumber });
  if (!user || !(await verifyPassword(user.password_hash, password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const result = issueTokensForGrant({
    userId: user.id,
    clientId,
    extraClientIds: Array.isArray(extraClientIds) ? extraClientIds : [extraClientIds],
    claims,
    topicClaims,
    providerClaim
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.token);
});

/**
 * @openapi
 * /api/oauth/introspect:
 *   post:
 *     summary: Introspect an opaque access token
 *     description: |
 *       Looks up the token hash and returns stored claims if the token is an unexpired,
 *       unrevoked access token and at least one claim still has a live user grant.
 *     tags:
 *       - OAuth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token: { type: string }
 *               access_token: { type: string }
 *     responses:
 *       200:
 *         description: active=false or the claim document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TokenIntrospection'
 */
router.post('/introspect', (req, res) => {
  const raw = req.body.token || req.body.access_token || req.body.accessToken;
  const info = validateAccessToken(raw);
  if (!info.active) return res.json({ active: false });
  res.json(info);
});

/**
 * @openapi
 * /api/oauth/revoke:
 *   post:
 *     summary: Revoke an access or refresh token
 *     description: Always 204. Unknown tokens are ignored.
 *     tags:
 *       - OAuth
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token: { type: string }
 *     responses:
 *       204:
 *         description: Revoked or already unknown
 */
router.post('/revoke', (req, res) => {
  const raw = req.body.token || req.body.access_token || req.body.refresh_token;
  revokeToken(raw);
  res.status(204).end();
});

/**
 * @openapi
 * /api/oauth/tokeninfo:
 *   get:
 *     summary: Return claims of the current Bearer token
 *     description: Requires Authorization. Returns the same document as a successful introspect.
 *     tags:
 *       - OAuth
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Active token claims
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TokenIntrospection'
 *       401:
 *         description: Missing or invalid access token
 */
router.get('/tokeninfo', requireAuth, (req, res) => {
  res.json(req.auth);
});

module.exports = router;
