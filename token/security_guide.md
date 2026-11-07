# Passport.js Security Implementation Guide

## Overview

This guide covers the security considerations and proper implementation of Passport.js OAuth authentication in the FHIR Token Server.

## Key Security Features Implemented

### 1. **Session Security**
```javascript
// Secure session configuration
{
  store: SQLiteStore,           // Persistent session storage
  secret: crypto.randomBytes(64), // Strong session secret
  name: 'fhir.token.sid',      // Custom session name (security through obscurity)
  resave: false,               // Don't save unchanged sessions
  saveUninitialized: false,    // Don't create sessions until something stored
  rolling: true,               // Reset expiration on each request
  cookie: {
    secure: this.config.cookieSecure ?? 'auto', // Secure when the request came over https (req.secure)
    httpOnly: true,            // Prevent XSS access to cookies
    maxAge: 24 * 60 * 60 * 1000, // 24 hour expiration
    sameSite: 'lax'           // CSRF protection
  }
}
```

### 2. **CSRF Protection**
```javascript
// Using Lusca for comprehensive protection
lusca({
  csrf: true,                  // CSRF token validation
  csp: { /* Content Security Policy */ },
  xframe: 'SAMEORIGIN',       // Clickjacking protection
  hsts: { maxAge: 31536000 }, // Force HTTPS
  xssProtection: true,        // XSS header
  nosniff: true              // MIME sniffing protection
})
```

### 3. **Rate Limiting**
```javascript
// OAuth authentication rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 5,                     // 5 attempts per window
  message: 'Too many authentication attempts'
});
```

### 4. **API Key Security**
```javascript
// Secure key generation and storage
const keyData = crypto.randomBytes(32);      // Cryptographically secure
const keyHash = await bcrypt.hash(fullKey, 12); // Strong bcrypt rounds
const keyPrefix = 'tk_' + crypto.randomBytes(4).toString('hex'); // Identifiable prefix
```

## OAuth Provider Security

### 1. **Google OAuth Configuration**
```javascript
// Recommended Google OAuth settings
{
  clientID: 'your-google-client-id',
  clientSecret: 'your-google-client-secret',
  callbackURL: 'https://yourdomain.com/token/callback/google', // HTTPS required
  scope: ['openid', 'profile', 'email'], // Minimal required scopes
  prompt: 'select_account' // Force account selection
}
```

### 2. **Facebook OAuth Configuration**
```javascript
{
  clientID: 'your-facebook-app-id',
  clientSecret: 'your-facebook-app-secret',
  callbackURL: 'https://yourdomain.com/token/callback/facebook',
  profileFields: ['id', 'emails', 'name'], // Limit profile data
  enableProof: true // App secret proof for added security
}
```

### 3. **GitHub OAuth Configuration**
```javascript
{
  clientID: 'your-github-client-id',
  clientSecret: 'your-github-client-secret',
  callbackURL: 'https://yourdomain.com/token/callback/github',
  scope: ['user:email'], // Minimal scope for email access
  userAgent: 'YourApp/1.0' // Identify your application
}
```

## Security Audit Trail

### 1. **Security Event Logging**
All security-relevant events are logged:
- OAuth login attempts
- API key creation/deletion
- Failed authentication attempts
- Suspicious activity patterns

```javascript
await this.logSecurityEvent(userId, 'oauth_login', req.ip, req.get('User-Agent'), {
  provider: 'google',
  provider_id: profile.id
});
```

### 2. **Usage Tracking**
- Daily request counts per API key
- IP address tracking for usage patterns
- Anomaly detection capabilities

## Production Deployment Checklist

### 1. **Environment Variables**
```bash
# Required environment variables
NODE_ENV=production
SESSION_SECRET=your-super-secret-session-key-64-chars-minimum
CSRF_SECRET=your-csrf-secret-key

# OAuth Provider Credentials
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
FACEBOOK_CLIENT_ID=your-facebook-app-id
FACEBOOK_CLIENT_SECRET=your-facebook-app-secret
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
```

### 2. **OAuth Provider Setup**

#### Google Cloud Console:
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google+ API and Google OAuth2 API
4. Go to Credentials → Create OAuth 2.0 Client ID
5. Set authorized redirect URIs: `https://yourdomain.com/token/auth/google/callback`
6. Configure OAuth consent screen with minimal scopes

#### Facebook for Developers:
1. Go to [Facebook for Developers](https://developers.facebook.com/)
2. Create a new app or select existing
3. Add Facebook Login product
4. Configure Valid OAuth Redirect URIs: `https://yourdomain.com/token/auth/facebook/callback`
5. Set app domain and privacy policy URL
6. Request only `email` permission

#### GitHub OAuth Apps:
1. Go to GitHub Settings → Developer settings → OAuth Apps
2. Create new OAuth App
3. Set Authorization callback URL: `https://yourdomain.com/token/auth/github/callback`
4. Configure application name and homepage URL

### 3. **Database Security**
```javascript
// Database connection with security settings
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) throw err;
  
  // Enable foreign key constraints
  db.run('PRAGMA foreign_keys = ON');
  
  // Set secure database settings
  db.run('PRAGMA journal_mode = WAL'); // Write-Ahead Logging
  db.run('PRAGMA synchronous = NORMAL'); // Balance performance/safety
  db.run('PRAGMA temp_store = MEMORY'); // Store temp data in memory
});
```

### 4. **HTTPS Configuration**
```javascript
// Production server setup with HTTPS
const https = require('https');
const fs = require('fs');

const options = {
  key: fs.readFileSync('path/to/private-key.pem'),
  cert: fs.readFileSync('path/to/certificate.pem'),
  // Optional: intermediate certificates
  ca: fs.readFileSync('path/to/ca-bundle.pem')
};

https.createServer(options, app).listen(443, () => {
  console.log('HTTPS server running on port 443');
});
```

## Security Best Practices

### 1. **API Key Management**
- Keys are shown only once during creation
- Keys are hashed with bcrypt (12 rounds)
- Key prefixes allow for efficient database lookup
- Usage tracking for anomaly detection
- Configurable expiration dates
- Scope-based permissions

### 2. **User Session Management**
- Sessions stored in database, not memory
- Session rotation on privilege change
- Automatic cleanup of expired sessions
- Logout destroys both session and cookies

### 3. **OAuth State Management**
- CSRF protection via state parameter
- State values are cryptographically random
- State is validated on callback
- Short-lived state tokens

### 4. **Input Validation**
- All inputs sanitized and validated
- SQL injection prevention via parameterized queries
- XSS prevention via output encoding
- Rate limiting on all endpoints

### 5. **Error Handling**
- Generic error messages to prevent information leakage
- Detailed logging for administrators
- Graceful degradation on service failures
- No sensitive data in error responses

## Monitoring and Alerting

### 1. **Security Events to Monitor**
- Multiple failed authentication attempts
- API key creation from new IP addresses
- Unusual usage patterns
- Session hijacking attempts
- OAuth callback failures

### 2. **Log Analysis**
```javascript
// Example log entries to monitor
{
  "level": "warn",
  "message": "Failed authentication attempt",
  "ip": "192.168.1.100",
  "userAgent": "Mozilla/5.0...",
  "provider": "google",
  "timestamp": "2025-09-14T10:30:00Z"
}
```

## Compliance Considerations

### 1. **GDPR Compliance**
- User consent for data processing
- Right to data portability
- Right to erasure (delete account)
- Data minimization (only collect necessary data)
- Privacy by design

### 2. **HIPAA Considerations** (if handling health data)
- Encryption at rest and in transit
- Access logging and audit trails
- User authentication and authorization
- Business Associate Agreements with OAuth providers

## Testing Security

### 1. **Automated Security Testing**
```javascript
// Example security tests
describe('OAuth Security', () => {
  test('should reject requests without CSRF token', async () => {
    const response = await request(app)
      .post('/token/keys')
      .send({ name: 'test' });
    expect(response.status).toBe(403);
  });

  test('should rate limit authentication attempts', async () => {
    // Make 6 failed requests
    for (let i = 0; i < 6; i++) {
      await request(app).get('/token/auth/google');
    }
    const response = await request(app).get('/token/auth/google');
    expect(response.status).toBe(429);
  });
});
```

### 2. **Manual Security Testing**
- Penetration testing of OAuth flows
- Session management testing
- CSRF attack simulation
- XSS vulnerability testing
- SQL injection testing

This comprehensive security implementation ensures that your Passport.js OAuth integration follows security best practices and protects both user data and API access.