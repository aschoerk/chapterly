module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.jsx?$': 'babel-jest',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(uuid|http-proxy-middleware|httpxy)/)'
  ],
  moduleNameMapper: {
    '\\.(css|scss)$': 'identity-obj-proxy'
  },
  testEnvironment: 'node'
};

// jest.setup.js

// Catch unhandled rejection / exception events during test execution
process.on('unhandledRejection', (reason) => {
  if (reason && String(reason.message).includes('SQLITE')) {
    console.error('❌ [JEST SQLITE ASYNC ERROR]:', reason.message);
  }
});

process.on('uncaughtException', (err) => {
  if (err && String(err.message).includes('SQLITE')) {
    console.error('❌ [JEST SQLITE SYNC ERROR]:', err.message);
  }
});
