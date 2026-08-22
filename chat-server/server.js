const { createApp } = require('./src/app');
const portfinder = require('portfinder');

(async () => {
  const app = createApp();

  portfinder.basePort = 3000;
  const PORT = await portfinder.getPortPromise();

  app.listen(PORT, () => {
    console.log(`✅ Chat server running on http://localhost:${PORT}`);
  });
})();
