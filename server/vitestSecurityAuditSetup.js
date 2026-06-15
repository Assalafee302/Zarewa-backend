/** Ensures integration tests share CSRF enforcement when using testIntegrationHarness. */
process.env.NODE_ENV = 'test';
process.env.ZAREWA_TEST_ENFORCE_CSRF = '1';
