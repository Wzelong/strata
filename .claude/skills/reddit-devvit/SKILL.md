---
name: reddit-devvit
description: Build Reddit Devvit apps (interactive posts, mod tools, games) using Devvit Web. Covers devvit.json config, server/client architecture (Hono), Redis, Reddit API, triggers, scheduler, realtime, menu actions, forms, and custom posts. Use when creating or modifying a Devvit app, writing server endpoints, configuring permissions, or working with @devvit packages.
---

# Reddit Devvit Web Development

## Architecture

Devvit Web apps have two sides:
- **Server** (`src/server/index.ts`): Hono-based Node.js server, compiled to CJS. Handles API routes, triggers, scheduler jobs, menu actions.
- **Client** (`src/client/`): HTML/JS/CSS served as web views inside Reddit posts. Can use React, vanilla JS, or any framework.

Imports:
```typescript
// Server
import { redis, reddit, context, scheduler, realtime, cache, settings, createServer, getServerPort } from '@devvit/web/server';
import type { MenuItemRequest, UiResponse, TaskRequest, TaskResponse, TriggerResponse, OnPostSubmitRequest, OnCommentCreateRequest } from '@devvit/web/shared';

// Client
import { showToast, showForm, navigateTo, requestExpandedMode, exitExpandedMode, getWebViewMode, connectRealtime } from '@devvit/web/client';
import { context } from '@devvit/web/client'; // access postData, postId, etc.
```

## devvit.json (required)

Minimal config:
```json
{
  "$schema": "https://developers.reddit.com/schema/config-file.v1.json",
  "name": "my-app",
  "post": {
    "dir": "dist/client",
    "entrypoints": {
      "default": { "entry": "index.html", "height": "tall" }
    }
  },
  "server": { "entry": "src/server/index.js" },
  "permissions": {
    "redis": true,
    "reddit": { "enable": true }
  }
}
```

Key fields: See [devvit-config.md](devvit-config.md) for full reference.

## Server pattern (Hono)

```typescript
import { Hono } from 'hono';
import { createServer, getServerPort, redis, reddit, context } from '@devvit/web/server';

const app = new Hono();

// Public API (client calls these)
app.get('/api/data', async (c) => {
  const { postId } = context;
  const value = await redis.get(`post:${postId}:data`);
  return c.json({ value });
});

// Internal endpoints (triggers, menu, scheduler)
app.post('/internal/triggers/post-create', async (c) => {
  const input = await c.req.json<OnPostSubmitRequest>();
  return c.json<TriggerResponse>({ status: 'ok' });
});

const server = createServer(app);
server.on('error', (err) => console.error(err.stack));
server.listen(getServerPort());
```

## Client fetch pattern

Client can only fetch its own server endpoints ending with `/api`:
```typescript
const response = await fetch('/api/data');
const data = await response.json();
```

## Custom posts

```typescript
import { reddit } from '@devvit/web/server';

await reddit.submitCustomPost({
  subredditName: context.subredditName!,
  title: 'My Post',
  entry: 'default',
  postData: { score: 0 },
  styles: {
    backgroundColor: '#FFFFFFFF',
    backgroundColorDark: '#000000FF',
    height: 'TALL'
  }
});
```

## Redis

See [redis.md](redis.md) for full command reference.

```typescript
import { redis } from '@devvit/web/server';

await redis.set('key', 'value');
const val = await redis.get('key');
await redis.hSet('hash', { field: 'value' });
await redis.zAdd('leaderboard', { member: 'user1', score: 100 });
```

## Menu actions + Forms

```json
// devvit.json
{
  "menu": {
    "items": [{
      "label": "My Action",
      "endpoint": "/internal/menu/my-action",
      "location": "post",
      "forUserType": "moderator"
    }]
  },
  "forms": {
    "myForm": "/internal/form/my-form"
  }
}
```

```typescript
// Show form from menu
app.post('/internal/menu/my-action', async (c) => {
  return c.json<UiResponse>({
    showForm: {
      name: 'myForm',
      form: {
        title: 'My Form',
        fields: [
          { name: 'input', label: 'Enter value', type: 'string' }
        ]
      }
    }
  });
});

// Handle form submission
app.post('/internal/form/my-form', async (c) => {
  const { input } = await c.req.json<{ input: string }>();
  return c.json<UiResponse>({ showToast: { text: 'Done!', appearance: 'success' } });
});
```

## Triggers

```json
{ "triggers": { "onPostSubmit": "/internal/triggers/post-submit" } }
```

Available: `onPostCreate`, `onPostSubmit`, `onPostUpdate`, `onPostDelete`, `onPostReport`, `onCommentCreate`, `onCommentSubmit`, `onCommentDelete`, `onCommentReport`, `onModAction`, `onModMail`, `onAppInstall`, `onAppUpgrade`

## Scheduler

```json
{
  "scheduler": {
    "tasks": {
      "cleanup": { "endpoint": "/internal/cron/cleanup", "cron": "0 2 * * *" },
      "one-off": { "endpoint": "/internal/scheduler/one-off" }
    }
  }
}
```

Runtime scheduling:
```typescript
await scheduler.runJob({ name: 'one-off', runAt: new Date(Date.now() + 60000), data: { postId } });
```

## Realtime

Server sends, client receives:
```typescript
// Server
import { realtime } from '@devvit/web/server';
await realtime.send('game-channel', { type: 'update', score: 42 });

// Client
import { connectRealtime } from '@devvit/web/client';
const conn = await connectRealtime({
  channel: 'game-channel',
  onMessage: (data) => console.log(data)
});
```

## View modes

- **Inline**: Loads in post unit. Tap/click only. Must load <1s.
- **Expanded**: Full screen (mobile) / modal (web). User-initiated only.

```typescript
import { requestExpandedMode } from '@devvit/web/client';
button.addEventListener('click', (e) => requestExpandedMode(e, 'game'));
```

## Vite plugin

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devvit } from '@devvit/start/vite';

export default defineConfig({ plugins: [react(), devvit()] });
```

## CLI commands

```
npx devvit init      # create new app (opens browser to choose template + name, creates folder)
npm run dev          # playtest (uses devvit.json scripts.dev)
npx devvit upload   # upload to app directory
npx devvit logs <subreddit>  # stream logs
npx devvit playtest [subreddit]
npx devvit install <subreddit> [app@version]
```

Note: `devvit new --here` is NOT supported. Use `devvit init` from the parent directory — it opens a browser link to choose template/name and creates the project folder.

## Constraints

- Server must compile to CJS (no ESM)
- Client fetch: only own domain, endpoints must end with `/api`
- Redis: 500MB storage, 5MB max request, 40k commands/sec per install
- Scheduler: max 10 recurring jobs, 60 creates/min, 60 deliveries/min
- HTTP fetch: allowlisted domains only, 30s timeout, https only
- Post data: 2KB max, JSON-serializable
- All internal endpoints must start with `/internal/`

## Rules & compliance

See [devvit-rules.md](devvit-rules.md) for full policy reference. Key points:

- Only approved LLMs: OpenAI (`api.openai.com`) and Google Gemini (`generativelanguage.googleapis.com`)
- Must honor user deletion events (onPostDelete, onCommentDelete triggers) — delete content from Redis/external services
- No Reddit trademarks (REDDIT, SNOO) without written permission
- No linking out to external apps or off-platform versions
- User actions (runAs USER) require explicit manual trigger, clear attribution, `userGeneratedContent` set
- Apps using fetch/payments/LLMs need own terms of service + privacy policy
- Do not collect passwords, profile users, sell data, or target under-13
