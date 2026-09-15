const express = require('express');
const { describeEnvironment } = require('../runtimeEnv');

const router = express.Router();

/**
 * @openapi
 * /api/environment:
 *   get:
 *     summary: Current runtime, storage split and login state
 *     description: |
 *       Lets the SPA decide how to persist data and whether to show login.
 *
 *       runtime:
 *       - electron-sqlite
 *       - electron-chat-server
 *       - docker-prod
 *       - docker-dev
 *       - gcloud
 *
 *       storage.profile (partly SQLite splits):
 *       - sqlite-all
 *       - chats-params-idb
 *       - content-idb
 *       - theme-local (personas + environments/projects in IDB)
 *
 *       auth.login is none | google | direct. Electron always reports none.
 *       Override with CHAPTERLY_RUNTIME and CHAPTERLY_STORAGE.
 *     tags:
 *       - Environment
 *     security:
 *       - {}
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Environment document
 */
router.get('/', (req, res) => {
  res.json(describeEnvironment(req));
});

module.exports = router;
