# Nginx + Passport.js Configuration Guide

## Architecture Overview

```
Client Browser
    ↓ HTTPS (443) / HTTP (80)
Nginx Reverse Proxy
    ↓ HTTP (3000) - Internal Network
Node.js App (Passport.js)
```

This setup works perfectly with Passport.js, but requires proper configuration to handle the proxy correctly.

## Required Configuration Changes

### 1. **Express Trust Proxy Configuration**

Add this to your main `server.js` before initializing routes:

```javascript
// server.js - Add after creating the Express app
const app = express();

// Trust the nginx proxy - CRITICAL for proper IP handling
app.set('trust proxy', 1);

// Alternative: Trust specific proxy IP
// app.set('trust proxy', '127.0.0.1');

// Rest of your middleware...
```

### 2. **Updated Token Module for Proxy Support**

```javascript
// In token.js, update session configuration
initializeSession() {
  const sessionConfig = {
    store: new SQLiteStore({
      db: this.config.database || 'token.db',
      table: 'sessions'
    }),
    secret: this.config.sessionSecret || crypto.randomBytes(64).toString('hex'),
    name: 'fhir.token.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      // This is key - secure cookies when behind HTTPS proxy
      secure: this.config.cookieSecure ?? 'auto', // Secure when the request came over https (req.secure)
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax'
    },
    proxy: true // Important for proxied environments
  };

  this.router.use(session(sessionConfig));
}
```

### 3. **Environment-Specific OAuth Configuration**

Update your `config.json` with environment-specific URLs:

```json
{
  "server": {
    "port": 3000,
    "httpsProxy": true,
    "cors": {
      "origin": true,
      "credentials": true
    }
  },
  "modules": {
    "token": {
      "enabled": true,
      "database": "/absolute/path/to/token.db",
      "sessionSecret": "your-session-secret",
      "oauth": {
        "google": {
          "clientId": "your-google-client-id",
          "clientSecret": "your-google-client-secret",
          "redirectUri": "https://local.fhir.org/token/auth/google/callback",
          "scope": ["openid", "profile", "email"]
        },
        "facebook": {
          "clientId": "your-facebook-app-id",
          "clientSecret": "your-facebook-app-secret",
          "redirectUri": "https://local.fhir.org/token/auth/facebook/callback",
          "scope": ["email"]
        },
        "github": {
          "clientId": "your-github-client-id",
          "clientSecret": "your-github-client-secret",
          "redirectUri": "https://local.fhir.org/token/auth/github/callback",
          "scope": ["user:email"]
        }
      }
    }
  }
}
```

### 4. **Production Configuration**

For production, update OAuth redirect URIs to use `tokens.fhir.org`:

```json
{
  "oauth": {
    "google": {
      "redirectUri": "https://tokens.fhir.org/token/auth/google/callback"
    },
    "facebook": {
      "redirectUri": "https://tokens.fhir.org/token/auth/facebook/callback"
    },
    "github": {
      "redirectUri": "https://tokens.fhir.org/token/auth/github/callback"
    }
  }
}
```

## Nginx Configuration

### Development (local.fhir.org)

```nginx
server {
    listen 80;
    server_name local.fhir.org;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name local.fhir.org;
    
    # SSL configuration for local development
    ssl_certificate /path/to/local.fhir.org.crt;
    ssl_certificate_key /path/to/local.fhir.org.key;
    
    # Security headers
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_cache_bypass $http_upgrade;
        
        # Important for OAuth callbacks
        proxy_redirect http://127.0.0.1:3000 https://local.fhir.org;
    }
}
```

### Production (tokens.fhir.org)

```nginx
server {
    listen 80;
    server_name tokens.fhir.org;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tokens.fhir.org;
    
    # SSL configuration
    ssl_certificate /path/to/tokens.fhir.org.crt;
    ssl_certificate_key /path/to/tokens.fhir.org.key;
    
    # Enhanced security headers for production
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";
    add_header Referrer-Policy "strict-origin-when-cross-origin";
    
    # Rate limiting
    limit_req_zone $binary_remote_addr zone=auth:10m rate=5r/m;
    limit_req zone=auth burst=10 nodelay;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        proxy_redirect http://127.0.0.1:3000 https://tokens.fhir.org;
    }
    
    # Optional: Serve static files directly from nginx
    location /assets/ {
        alias /path/to/app/static/assets/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

## OAuth Provider Registration

### Development URLs
When registering your app with OAuth providers for development:

**Google Cloud Console:**
- Authorized JavaScript origins: `https://local.fhir.org`
- Authorized redirect URIs: `https://local.fhir.org/token/auth/google/callback`

**Facebook for Developers:**
- Valid OAuth Redirect URIs: `https://local.fhir.org/token/auth/facebook/callback`
- App Domains: `local.fhir.org`

**GitHub OAuth Apps:**
- Authorization callback URL: `https://local.fhir.org/token/auth/github/callback`

### Production URLs
For production, register separate apps or add additional URLs:

- Google: `https://tokens.fhir.org/token/auth/google/callback`
- Facebook: `https://tokens.fhir.org/token/auth/facebook/callback`
- GitHub: `https://tokens.fhir.org/token/auth/github/callback`

## Environment Configuration

### Development Environment Variables

```bash
# .env.development
NODE_ENV=development
PORT=3000
SESSION_SECRET=your-dev-session-secret
BEHIND_PROXY=true

# OAuth Development
GOOGLE_CLIENT_ID=your-dev-google-client-id
GOOGLE_CLIENT_SECRET=your-dev-google-client-secret
FACEBOOK_CLIENT_ID=your-dev-facebook-client-id
FACEBOOK_CLIENT_SECRET=your-dev-facebook-client-secret
GITHUB_CLIENT_ID=your-dev-github-client-id
GITHUB_CLIENT_SECRET=your-dev-github-client-secret
```

### Production Environment Variables

```bash
# .env.production
NODE_ENV=production
PORT=3000
SESSION_SECRET=your-production-session-secret-64-chars-minimum
BEHIND_PROXY=true

# OAuth Production
GOOGLE_CLIENT_ID=your-prod-google-client-id
GOOGLE_CLIENT_SECRET=your-prod-google-client-secret
FACEBOOK_CLIENT_ID=your-prod-facebook-client-id
FACEBOOK_CLIENT_SECRET=your-prod-facebook-client-secret
GITHUB_CLIENT_ID=your-prod-github-client-id
GITHUB_CLIENT_SECRET=your-prod-github-client-secret
```

## Configuration Loading

Update your server.js to handle environment-specific configs:

```javascript
// server.js - Enhanced configuration loading
let config;
try {
  const configFile = process.env.NODE_ENV === 'production' ? 'config.production.json' : 'config.json';
  const configPath = path.join(__dirname, configFile);
  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
  
  // Override with environment variables if present
  if (process.env.SESSION_SECRET) {
    config.modules.token.sessionSecret = process.env.SESSION_SECRET;
  }
  
  // OAuth environment overrides
  const oauthOverrides = {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET
    },
    facebook: {
      clientId: process.env.FACEBOOK_CLIENT_ID,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET
    }
  };
  
  Object.keys(oauthOverrides).forEach(provider => {
    if (config.modules.token.oauth[provider] && oauthOverrides[provider].clientId) {
      config.modules.token.oauth[provider] = {
        ...config.modules.token.oauth[provider],
        ...oauthOverrides[provider]
      };
    }
  });
  
  serverLog.info(`Loaded ${configFile}. Active modules = ${Object.keys(config.modules).filter(mod => config.modules[mod].enabled).join(', ')}`);
} catch (error) {
  serverLog.error('Failed to load configuration:', error.message);
  process.exit(1);
}
```

## Testing the Setup

### 1. **Local Development Test**
```bash
# Start your Node.js server
npm run dev

# Test the OAuth flow
curl -I https://local.fhir.org/token/auth/google

# Should return 302 redirect to Google OAuth
```

### 2. **Production Deployment Test**
```bash
# Test OAuth endpoints
curl -I https://tokens.fhir.org/token/auth/google
curl -I https://tokens.fhir.org/token/auth/facebook
curl -I https://tokens.fhir.org/token/auth/github
```

## Troubleshooting Common Issues

### 1. **"Invalid Redirect URI" Error**
- Ensure OAuth app registration URLs exactly match your callback URLs
- Check for trailing slashes in URLs
- Verify HTTPS vs HTTP protocol

### 2. **Session Issues Behind Proxy**
- Ensure `app.set('trust proxy', 1)` is set
- Verify nginx proxy headers are correctly configured
- Check that `secure: true` is set for cookies in production

### 3. **CSRF Token Errors**
- Verify nginx is passing all headers correctly
- Ensure `X-Forwarded-Proto` header is set to `https`
- Check that `sameSite` cookie setting is appropriate

### 4. **IP Address Logging Issues**
- If you see 127.0.0.1 instead of real IPs, check `trust proxy` setting
- Verify `X-Real-IP` and `X-Forwarded-For` headers in nginx config

This setup provides a robust, production-ready OAuth implementation behind nginx proxy that works seamlessly with Passport.js!