const { createApp } = require('./src/app');

(async () => {
  console.log('>>> Starting chat-server, PID:', process.pid);
  const app = createApp();

  const PORT = process.env.PORT || 3847;

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Chat server running on http://0.0.0.0:${PORT} started by server.js`);
  });
})();
