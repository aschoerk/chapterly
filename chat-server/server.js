const { createApp } = require('./src/app');

(async () => {
  console.log('>>> Starting chat-server, PID:', process.pid);
  const app = createApp();

  const PORT = process.env.PORT || 3847;

  app.listen(PORT, () => {
    console.log(`✅ Chat server running on http://localhost:${PORT} started by server.js`);
  });
})();
