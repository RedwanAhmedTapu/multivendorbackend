export const courierConfig = {
  pathao: {
    baseUrl: process.env.PATHAO_BASE_URL || 'https://courier-api-sandbox.pathao.com',
    clientId: process.env.PATHAO_CLIENT_ID || '7N1aMJQbWm',
    clientSecret: process.env.PATHAO_CLIENT_SECRET || 'wRcaibZkUdSNz2EI9ZyuXLlNrnAv0TdPUPXMnD39',
    username: process.env.PATHAO_USERNAME || 'test@pathao.com',
    password: process.env.PATHAO_PASSWORD || 'lovePathao',
    grantType: 'password'
  },
  redx: {
    baseUrl: process.env.REDX_BASE_URL || 'https://sandbox.redx.com.bd/v1.0.0-beta',
    token: process.env.REDX_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiaWF0IjoxNzM1NTMxNjU2LCJpc3MiOiJ0OTlnbEVnZTBUTm5MYTNvalh6MG9VaGxtNEVoamNFMyIsInNob3BfaWQiOjEsInVzZXJfaWQiOjZ9.zpKfyHK6zPBVaTrYevnCqnUA-e2jFKQJ7lK-z4aOx2g'
  },
  steadfast: {
    apiKey: process.env.STEADFAST_API_KEY || 'y0cr6iyhgtgrouerbpsq7q9kuhy2ghnk',
    secretKey: process.env.STEADFAST_SECRET_KEY || 'eey9w6ihiluolc34omavyx8r'
  }
};

export const sslcommerzConfig = {
  storeId: process.env.SSLCOMMERZ_STORE_ID || 'finix68a4171b448f6',
  storePassword: process.env.SSLCOMMERZ_STORE_PASSWORD || 'finix68a4171b448f6@ssl',
  baseUrl: process.env.SSLCOMMERZ_BASE_URL || 'https://sandbox.sslcommerz.com'
};