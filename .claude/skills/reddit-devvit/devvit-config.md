# devvit.json Configuration Reference

## Table of Contents
- [Required properties](#required-properties)
- [Post configuration](#post-configuration)
- [Server configuration](#server-configuration)
- [Permissions](#permissions)
- [Triggers](#triggers)
- [Menu](#menu)
- [Scheduler](#scheduler)
- [Forms](#forms)
- [Settings](#settings)
- [Scripts](#scripts)
- [Dev](#dev)
- [Marketing assets](#marketing-assets)

## Required properties

- `name`: 3-16 chars, lowercase, letters/numbers/hyphens, starts with letter
- At least one of `post` or `server`

## Post configuration

```json
{
  "post": {
    "dir": "dist/client",
    "entrypoints": {
      "default": { "entry": "index.html", "height": "tall", "inline": true },
      "game": { "entry": "game.html" }
    }
  }
}
```

- `height`: `"regular"` (320px) or `"tall"` (512px)
- `inline`: true = loads in post unit without click

## Server configuration

```json
{ "server": { "entry": "src/server/index.js" } }
```

Must be CJS. Default entry: `src/server/index.js`

## Permissions

```json
{
  "permissions": {
    "http": { "enable": true, "domains": ["api.example.com"] },
    "redis": true,
    "reddit": { "enable": true, "scope": "moderator", "asUser": ["SUBMIT_POST"] },
    "media": true,
    "payments": false,
    "realtime": true
  }
}
```

- `http.domains`: exact hostnames, no wildcards/protocols/paths
- `reddit.scope`: `"user"` (default) or `"moderator"`
- `reddit.asUser`: APIs to execute as user account

## Triggers

```json
{
  "triggers": {
    "onPostSubmit": "/internal/triggers/post-submit",
    "onCommentCreate": "/internal/triggers/comment-create",
    "onAppInstall": "/internal/triggers/app-install"
  }
}
```

All trigger types: `onAppInstall`, `onAppUpgrade`, `onPostCreate`, `onPostDelete`, `onPostSubmit`, `onPostUpdate`, `onPostReport`, `onPostFlairUpdate`, `onPostNsfwUpdate`, `onPostSpoilerUpdate`, `onCommentCreate`, `onCommentDelete`, `onCommentSubmit`, `onCommentUpdate`, `onCommentReport`, `onModAction`, `onModMail`, `onAutomoderatorFilterPost`, `onAutomoderatorFilterComment`

Requires `server` to be configured.

## Menu

```json
{
  "menu": {
    "items": [{
      "label": "Action Name",
      "description": "What it does",
      "forUserType": "moderator",
      "location": ["post", "comment"],
      "endpoint": "/internal/menu/action-name",
      "postFilter": "currentApp"
    }]
  }
}
```

- `location`: `"post"`, `"comment"`, `"subreddit"` (string or array)
- `forUserType`: `"moderator"` or `"user"` (default: `"moderator"`)
- `postFilter`: `"none"` (default) or `"currentApp"`

## Scheduler

```json
{
  "scheduler": {
    "tasks": {
      "recurring-task": {
        "endpoint": "/internal/cron/recurring",
        "cron": "0 * * * *"
      },
      "one-off-task": {
        "endpoint": "/internal/scheduler/one-off"
      }
    }
  }
}
```

Cron: 5-part (`0 2 * * *`) or 6-part with seconds (`*/30 * * * * *`)

## Forms

```json
{
  "forms": {
    "myForm": "/internal/forms/my-form"
  }
}
```

Maps form names (referenced in `showForm`) to submission handler endpoints.

## Settings

```json
{
  "settings": {
    "global": {
      "apiKey": { "type": "string", "label": "API Key", "isSecret": true, "defaultValue": "" }
    },
    "subreddit": {
      "welcome": {
        "type": "string",
        "label": "Welcome Message",
        "validationEndpoint": "/internal/settings/validate-welcome",
        "defaultValue": "Welcome!"
      },
      "mode": {
        "type": "select",
        "label": "Mode",
        "options": [
          { "label": "Easy", "value": "easy" },
          { "label": "Hard", "value": "hard" }
        ],
        "defaultValue": "easy"
      }
    }
  }
}
```

Types: `string`, `boolean`, `number`, `select`, `multiSelect`

## Scripts

```json
{
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build"
  }
}
```

- `dev`: run by `devvit playtest`
- `build`: run by `devvit upload`

## Dev

```json
{ "dev": { "subreddit": "my-test-sub" } }
```

Override with `DEVVIT_SUBREDDIT` env var.

## Marketing assets

```json
{ "marketingAssets": { "icon": "assets/icon.png" } }
```

Icon must be 1024x1024 PNG.
