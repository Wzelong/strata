# Reddit API Reference

## Table of Contents
- [Setup](#setup)
- [Context object](#context-object)
- [Posts](#posts)
- [Comments](#comments)
- [Users](#users)
- [Subreddits](#subreddits)
- [Moderation](#moderation)
- [Flair](#flair)
- [Wiki](#wiki)
- [Widgets](#widgets)
- [ModMail](#modmail)
- [Thing IDs](#thing-ids)

## Setup

```json
// devvit.json
{ "permissions": { "reddit": { "enable": true } } }
// For mod actions:
{ "permissions": { "reddit": { "enable": true, "scope": "moderator" } } }
// For user actions:
{ "permissions": { "reddit": { "enable": true, "asUser": ["SUBMIT_POST", "SUBMIT_COMMENT"] } } }
```

```typescript
import { reddit, context } from '@devvit/web/server';
```

## Context object

Available in server code:
```typescript
context.postId       // current post ID (t3_xxx)
context.subredditName
context.subredditId
context.userId
context.postData     // JSON object attached to post (2KB max)
```

## Posts

```typescript
const post = await reddit.getPostById('t3_abc123');
// post.title, post.id, post.authorName, post.subredditName, etc.

// Submit custom post
const newPost = await reddit.submitCustomPost({
  subredditName: 'mysub',
  title: 'Title',
  entry: 'default',
  postData: { key: 'value' },
  styles: { height: 'TALL', backgroundColor: '#FFFFFFFF' }
});

// Submit text post
await reddit.submitPost({
  subredditName: 'mysub',
  title: 'Title',
  text: 'Body text'
});

// Update post data
const post = await reddit.getPostById(context.postId);
await post.setPostData({ ...context.postData, newField: 'value' });

// Listings
const hot = await reddit.getHotPosts({ subredditName: 'memes', limit: 100 }).all();
const newPosts = await reddit.getNewPosts({ subredditName: 'memes' }).all();
const top = await reddit.getTopPosts({ subredditName: 'memes', timeframe: 'day' }).all();
```

## Comments

```typescript
const comment = await reddit.getCommentById('t1_abc123');
// comment.body, comment.authorName, comment.parentId, comment.replies

await reddit.submitComment({
  postId: 't3_abc123',
  text: 'Comment text'
});

// As user (requires asUser permission)
await reddit.submitComment({
  postId: 't3_abc123',
  text: 'User comment',
  runAs: 'USER'
});

const comments = await reddit.getComments({ postId: 't3_abc123', limit: 100 }).all();
```

## Users

```typescript
const user = await reddit.getCurrentUser();       // current viewer (undefined if logged out)
const username = await reddit.getCurrentUsername();
const appUser = await reddit.getAppUser();        // the app's account
const user = await reddit.getUserByUsername('spez');
const user = await reddit.getUserById('t2_xyz');
const snoovatar = await reddit.getSnoovatarUrl('username');
```

## Subreddits

```typescript
const sub = await reddit.getCurrentSubreddit();
const name = await reddit.getCurrentSubredditName();
const sub = await reddit.getSubredditInfoByName('askReddit');
const sub = await reddit.getSubredditInfoById('t5_2qjpg');
```

## Moderation

```typescript
await reddit.approve('t3_123456');
await reddit.remove('t3_123456', false); // false = not spam
await reddit.banUser({ subredditName: 'sub', username: 'user', reason: 'spam' });
await reddit.unbanUser('user', 'sub');
await reddit.muteUser({ subredditName: 'sub', username: 'user' });

// Mod notes
await reddit.addModNote({ subreddit: 'sub', user: 'username', note: 'Warning issued', label: 'ABUSE_WARNING' });

// Mod queue
const queue = await reddit.getModQueue({ subredditName: 'sub' }).all();
const reports = await reddit.getReports({ subredditName: 'sub' }).all();
const log = await reddit.getModerationLog({ subredditName: 'sub' }).all();
```

## Flair

```typescript
await reddit.setPostFlair({ subredditName: 'sub', postId: 't3_123', flairTemplateId: 'id' });
await reddit.setUserFlair({ subredditName: 'sub', username: 'user', text: 'Flair' });
await reddit.removePostFlair('sub', 't3_123');
const templates = await reddit.getPostFlairTemplates('sub');
```

## Wiki

```typescript
const page = await reddit.getWikiPage('sub', 'pagename');
await reddit.createWikiPage({ subredditName: 'sub', page: 'name', content: 'text' });
await reddit.updateWikiPage({ subredditName: 'sub', page: 'name', content: 'updated' });
```

## Widgets

```typescript
const widgets = await reddit.getWidgets('sub');
await reddit.addWidget({ subredditName: 'sub', /* widget data */ });
await reddit.deleteWidget('sub', 'widgetId');
```

## ModMail

```typescript
await reddit.modMail.reply({ body: 'Message', conversationId: 'id' });
```

## Thing IDs

| Prefix | Type | Example |
|--------|------|---------|
| t1_ | Comment | t1_abc123 |
| t2_ | User | t2_xyz789 |
| t3_ | Post | t3_def456 |
| t4_ | Message | t4_ghi012 |
| t5_ | Subreddit | t5_jkl345 |
