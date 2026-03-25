# NHL Stat — Railway Deployment

## Deploy to Railway in 3 steps

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Set these environment variables in Railway dashboard:

   SITE_PASSWORD=your_chosen_password
   SESSION_SECRET=any_random_long_string_here

Railway auto-detects Node.js and runs `npm start`.
The app stays live 24/7 on Railway's free/hobby tier.

## Environment Variables

| Variable        | Description                        | Default          |
|-----------------|------------------------------------|------------------|
| SITE_PASSWORD   | Password to access the dashboard   | nhlstat2026      |
| SESSION_SECRET  | Secret for session signing         | nhlstat-secret   |
| PORT            | Port (Railway sets this auto)      | 3000             |

## Local Dev

  npm install
  node server.js

Then open http://localhost:3000
