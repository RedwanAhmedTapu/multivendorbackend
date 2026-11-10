// ── Fail-closed: no hardcoded API keys/passwords/tokens. ──
// Previously this file shipped real-looking Pathao/RedX/Steadfast/SSLCommerz
// credentials as fallback defaults, which meant they were committed to git
// in plaintext even if .env was configured correctly everywhere else.
// If an env var below is missing, the app now refuses to start instead of
// silently signing requests with a leaked credential.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (set it in your environment/.env). Refusing to fall back to a hardcoded credential.`);
  }
  return value;
}

export const courierConfig = {
  pathao: {
    baseUrl: process.env.PATHAO_BASE_URL || 'https://courier-api-sandbox.pathao.com',
    clientId: requireEnv('PATHAO_CLIENT_ID'),
    clientSecret: requireEnv('PATHAO_CLIENT_SECRET'),
    username: requireEnv('PATHAO_USERNAME'),
    password: requireEnv('PATHAO_PASSWORD'),
    grantType: 'password'
  },
  redx: {
    baseUrl: process.env.REDX_BASE_URL || 'https://sandbox.redx.com.bd/v1.0.0-beta',
    token: requireEnv('REDX_TOKEN')
  },
  steadfast: {
    baseUrl: process.env.STEADFAST_BASE_URL || 'https://portal.packzy.com/api/v1',
    apiKey: requireEnv('STEADFAST_API_KEY'),
    secretKey: requireEnv('STEADFAST_SECRET_KEY')
  }
};

export const sslcommerzConfig = {
  storeId: requireEnv('SSLCOMMERZ_STORE_ID'),
  storePassword: requireEnv('SSLCOMMERZ_STORE_PASSWORD'),
  baseUrl: process.env.SSLCOMMERZ_BASE_URL || 'https://sandbox.sslcommerz.com'
};